import { COMMAND_REQUEST_VERSION, EXECUTION_RESULT_VERSION, type CommandRequest, type ExecutionResult, type FormattingCommandSet, type RecognitionResult } from "../../contracts/src/index.js";
import type { CapabilityProvider, CommandServiceClient, CommandValidator, DocumentExecutor, DocumentReader, FontCapabilityProvider, LicenseProvider, PreviewCommentService, PreviewDisplayMode, PreviewMutationTracker, RecognitionProvider, TransactionManager } from "./ports.js";

export type FormattingProgressStage = "preflight" | "snapshot" | "recognition" | "command_generation" | "command_validation" | "target_resolution" | "transaction_capture" | "format_application" | "readback" | "result_summary" | "rolling_back";
export interface FormattingExecutionOptions { onProgress?: (stage: FormattingProgressStage, detail?: string) => void; signal?: AbortSignal; }
export interface PreviewSummary {
  recognized_paragraph_count: number; mapped_paragraph_count: number; review_count: number; unknown_count: number;
  unresolved_block_count: number; mixed_paragraph_count: number;
  command_count: number; font_command_count: number; alignment_command_count: number; indent_command_count: number; spacing_command_count: number; page_command_count: number;
  missing_fonts: string[]; unsupported_capabilities: string[]; estimated_skip_count: number; blocking_reason: string | null;
  preview_session_id?: string; preview_comment_count?: number; preview_warnings?: string[];
}
export interface PreviewExecution { recognition: RecognitionResult; commands: FormattingCommandSet; summary: PreviewSummary; }

function requestFor(recognition: RecognitionResult, requestId: string, capabilities: CapabilityProvider, license: LicenseProvider): CommandRequest {
  return {
    schema_version: COMMAND_REQUEST_VERSION, request_id: requestId, recognition_result: recognition,
    profile_id: "default", profile_version: "1.0", client_capabilities: capabilities.capabilities(),
    product_version: "1.0", authorization_scope: license.authorizationScope(),
  };
}
function assertNotCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Error("FORMAT_CANCELLED"); }
function sameDocument(snapshot: { documentId: string; documentFullNameHash?: string }, tracker: PreviewMutationTracker): boolean {
  return snapshot.documentId === tracker.document_id && (snapshot.documentFullNameHash ?? "") === tracker.document_full_name_hash;
}
function unchangedSincePreview(snapshot: Awaited<ReturnType<DocumentReader["readSnapshot"]>>, tracker: PreviewMutationTracker): boolean {
  // Saving WPS comments may split runs and rewrite comment anchors, which
  // changes the formatting fingerprint without changing user document text
  // or structure.  The stale-recognition guard therefore uses the stable
  // body/order/section identity and lets the formal transaction capture the
  // current formatting immediately before applying commands.
  return sameDocument(snapshot, tracker) && snapshot.sourceSha256 === tracker.baseline_text_hash && snapshot.paragraphs.length === tracker.baseline_paragraph_count && snapshot.paragraphOrderHash === tracker.baseline_paragraph_order_hash && snapshot.sectionCount === tracker.baseline_section_count;
}

export class FormatDocumentUseCase {
  constructor(
    private readonly reader: DocumentReader, private readonly recognitionProvider: RecognitionProvider,
    private readonly commandService: CommandServiceClient, private readonly validator: CommandValidator,
    private readonly executor: DocumentExecutor, private readonly transactionManager: TransactionManager,
    private readonly capabilities: CapabilityProvider, private readonly license: LicenseProvider, private readonly fonts?: FontCapabilityProvider,
  ) {}
  async execute(requestId: string, options: FormattingExecutionOptions = {}): Promise<ExecutionResult> {
    const progress = (stage: FormattingProgressStage, detail?: string) => options.onProgress?.(stage, detail);
    progress("preflight", "检查文档"); assertNotCancelled(options.signal);
    const snapshot = await this.reader.readSnapshot();
    progress("snapshot", "保存原始文档状态");
    progress("recognition", "识别文档"); assertNotCancelled(options.signal);
    const recognition = await this.recognitionProvider.recognize(snapshot);
    const applicable = recognition.paragraphs.filter((item) => (
      item.formatting_disposition === "apply"
      && item.binding_status === "confirmed"
      && item.segment_count_total === item.segment_count_confirmed
      && item.segment_count_total === item.segment_count_located
    ));
    const skipped = recognition.paragraphs.length - applicable.length + (recognition.unresolved_blocks?.length ?? 0);
    if (!applicable.length) {
      progress("result_summary", "没有可安全应用的段落");
      return {
        schema_version: EXECUTION_RESULT_VERSION, transaction_id: "no-confirmed-targets",
        executed_command_ids: [], skipped_command_ids: [], failed_command_id: null,
        warnings: [`SKIPPED_REVIEW_OR_UNRESOLVED=${skipped}`], rolled_back: false,
        document_revision: snapshot.revision,
      };
    }
    progress("command_generation", "生成排版计划"); assertNotCancelled(options.signal);
    const request = requestFor({ ...recognition, paragraphs: applicable }, requestId, this.capabilities, this.license);
    const serviceResult = await this.commandService.requestCommands(request);
    progress("command_validation", "验证计划");
    const commandSet = this.validator.validate(serviceResult, requestId);
    this.assertCapabilities(commandSet);
    this.fonts?.assertAvailable(commandSet.commands.filter((item) => item.kind === "paragraph.set_font").flatMap((item) => [item.arguments.east_asia_font_name, item.arguments.latin_font_name]));
    const current = await this.reader.readSnapshot();
    if (current.revision !== snapshot.revision || current.formattingRevision !== snapshot.formattingRevision || current.paragraphOrderHash !== snapshot.paragraphOrderHash || current.sectionCount !== snapshot.sectionCount) throw new Error("DOCUMENT_CHANGED");
    progress("target_resolution", "定位目标"); assertNotCancelled(options.signal);
    const transactionId = this.transactionManager.begin();
    try {
      progress("transaction_capture", "保存原格式");
      progress("format_application", "应用页面设置和段落格式");
      const result = await this.executor.execute(commandSet, transactionId, snapshot.revision);
      progress("readback", "读回验证");
      if (result.rolled_back || result.failed_command_id) {
        progress("rolling_back", "正在回滚");
        this.transactionManager.rollback(transactionId);
      } else this.transactionManager.commit(transactionId);
      progress("result_summary", "完成");
      return skipped ? { ...result, warnings: [...result.warnings, `SKIPPED_REVIEW_OR_UNRESOLVED=${skipped}`] } : result;
    } catch (error) {
      progress("rolling_back", "正在回滚");
      this.transactionManager.rollback(transactionId);
      throw error;
    }
  }
  private assertCapabilities(commandSet: FormattingCommandSet): void {
    const supported = new Set(this.capabilities.capabilities().capabilities);
    for (const command of commandSet.commands) if (!supported.has(command.required_capability) && command.on_unsupported === "fail") throw new Error("CLIENT_CAPABILITY_MISSING");
  }
}
export class RecognizeDocumentUseCase {
  constructor(private readonly reader: DocumentReader, private readonly recognitionProvider: RecognitionProvider) {}
  async execute(): Promise<RecognitionResult> { return this.recognitionProvider.recognize(await this.reader.readSnapshot()); }
}
export class PreviewDocumentUseCase {
  constructor(private readonly reader: DocumentReader, private readonly recognitionProvider: RecognitionProvider, private readonly commandService: CommandServiceClient, private readonly validator: CommandValidator, private readonly capabilities: CapabilityProvider, private readonly license: LicenseProvider, private readonly fonts?: FontCapabilityProvider, private readonly previewComments?: PreviewCommentService, private readonly previewTracker?: { current(): PreviewMutationTracker | null; set(value: PreviewMutationTracker): void; clear(): void }) {}
  async execute(requestId: string, mode: PreviewDisplayMode = "all"): Promise<PreviewExecution> {
    const previous = this.previewTracker?.current() ?? null;
    if (previous && this.previewComments) {
      const current = await this.reader.readSnapshot({ allowUnsaved: true });
      if (!sameDocument(current, previous)) throw new Error("DOCUMENT_CHANGED");
      await this.previewComments.removePreviewComments(previous); this.previewTracker?.clear();
    }
    const snapshot = await this.reader.readSnapshot({ allowUnsaved: !!previous });
    const recognition = await this.recognitionProvider.recognize(snapshot);
    const commands = this.validator.validate(await this.commandService.requestCommands(requestFor(recognition, requestId, this.capabilities, this.license)), requestId);
    const count = (kind: FormattingCommandSet["commands"][number]["kind"]) => commands.commands.filter((item) => item.kind === kind).length;
    const unsupported = commands.commands.filter((item) => !this.capabilities.capabilities().capabilities.includes(item.required_capability)).map((item) => item.required_capability);
    const unresolved = recognition.unresolved_blocks?.length ?? 0;
    const review = recognition.paragraphs.filter((item) => item.needs_review).length + unresolved;
    const unknown = recognition.paragraphs.filter((item) => item.recognized_type === "unknown").length + unresolved;
    const critical = recognition.paragraphs.some((item) => item.review_level === "critical_review");
    const fontReport = this.fonts?.inspect(commands.commands.filter((item) => item.kind === "paragraph.set_font").flatMap((item) => [item.arguments.east_asia_font_name, item.arguments.latin_font_name])) ?? [];
    const missing = fontReport.filter((item) => !item.installed).map((item) => item.requested_font);
    const mixedParagraphs = new Set(recognition.paragraphs.filter((item) => item.mixed_structure).map((item) => item.source_paragraph_index));
    const mixed = mixedParagraphs.size > 0;
    const base = { recognized_paragraph_count: recognition.paragraphs.length + unresolved, mapped_paragraph_count: recognition.paragraphs.length, review_count: review, unknown_count: unknown, unresolved_block_count: unresolved, mixed_paragraph_count: mixedParagraphs.size, command_count: commands.commands.length, font_command_count: count("paragraph.set_font"), alignment_command_count: count("paragraph.set_alignment"), indent_command_count: count("paragraph.set_indent"), spacing_command_count: count("paragraph.set_spacing"), page_command_count: count("section.set_page_setup"), missing_fonts: [...new Set(missing)], unsupported_capabilities: [...new Set(unsupported)], estimated_skip_count: unsupported.length, blocking_reason: critical ? "CRITICAL_REVIEW_REQUIRED" : unresolved ? "RECOGNITION_LOCATOR_UNVERIFIED" : mixed ? "MIXED_PARAGRAPH_REQUIRES_SPLIT" : unknown ? "UNKNOWN_MAPPING_REVIEW_REQUIRED" : missing.length ? "FONT_NOT_INSTALLED" : null };
    // Unknown and missing-font paragraphs are exactly the cases that need a
    // visible review comment.  Only a critical structural decision blocks a
    // preview mutation altogether.
    if (!this.previewComments || critical) return { recognition, commands, summary: base };
    try { const result = await this.previewComments.addPreviewComments({ snapshot, recognition, commands, mode }); this.previewTracker?.set(result.tracker); return { recognition, commands, summary: { ...base, preview_session_id: result.tracker.preview_session_id, preview_comment_count: result.comment_count, preview_warnings: result.warnings } }; }
    catch (error) { return { recognition, commands, summary: { ...base, preview_comment_count: 0, preview_warnings: [error instanceof Error ? error.message : "COMMENT_PREVIEW_UNSUPPORTED"] } }; }
  }
}
export class ClearFormattingPreviewUseCase {
  constructor(private readonly comments: PreviewCommentService, private readonly tracker: { current(): PreviewMutationTracker | null; clear(): void }) {}
  async execute(): Promise<void> { const value = this.tracker.current(); if (!value) return; await this.comments.removePreviewComments(value); this.tracker.clear(); }
}
