import type { DiagnosticReporter } from "../../diagnostics/src/index.js";
import { type DocumentDescriptor, type HostParagraphData, type HostRpcResult, type JsonValue, type SerializableLocalDocumentSnapshot, type WorkerHostRequest } from "../../threading/src/protocol.js";
import { parseWorkerHostRequest } from "../../threading/src/validation.js";
import { stripWpsImplicitParagraphTerminator } from "./host-text.js";
import { WpsLocalFileSystem } from "./local-filesystem.js";
import { WpsRecognitionJobService } from "./recognition-jobs.js";
import { HOST_PREVIEW_BATCH_LIMIT, WpsPreviewBatchService } from "./preview-batches.js";
import type { PreviewPlanItem } from "./preview-comments.js";
import { assertFormattingCommandSet, type FormattingCommandSet } from "../../contracts/src/index.js";
import { WpsApiDocumentExecutor, WpsCapabilityProvider, WpsTransactionManager } from "./official-host.js";

type WpsObject = Record<string, any>;
export const HOST_PARAGRAPH_BATCH_LIMIT = 10;
export const HOST_FORMAT_BATCH_LIMIT = 12;
export interface WpsHostBridgeOptions {
  recognitionExecutablePath?: string;
  recognitionContractVersion?: number;
  maxRecognitionResultBytes?: number;
  brokerStatusPath?: string;
  brokerJobsPath?: string;
  brokerRuntimeVersion?: string;
  brokerRuntimeSha256?: string;
  brokerVersion?: string;
  brokerExecutablePathHash?: string;
  brokerExecutableSha256?: string;
  brokerQueueContractVersion?: number;
  probeExecutablePath?: string;
  enableDebugProbes?: boolean;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}
function code(error: unknown): string { const value = error instanceof Error ? error.message : "HOST_RPC_FAILED"; return /^[A-Z][A-Z0-9_]{1,100}$/.test(value) ? value : "HOST_RPC_FAILED"; }
function serialized(error: unknown): { code: string; message: string; stack?: string } { return { code: code(error), message: error instanceof Error ? error.message : "HOST_RPC_FAILED", ...(error instanceof Error && error.stack ? { stack: error.stack } : {}) }; }
function technicalDetail(error: unknown): string { const value = error && typeof error === "object" ? (error as { technical_detail?: unknown }).technical_detail : undefined; return typeof value === "string" ? value : ""; }
function snapshot(value: unknown): SerializableLocalDocumentSnapshot {
  const item = value as Partial<SerializableLocalDocumentSnapshot> | null;
  if (!item || item.snapshotContractVersion !== "worker-snapshot-v1" || typeof item.documentId !== "string" || typeof item.revision !== "string" || typeof item.textRevision !== "string" || typeof item.sourceSha256 !== "string" || typeof item.localDocxPath !== "string" || !Array.isArray(item.paragraphs)) throw new Error("INVALID_WORKER_SNAPSHOT");
  for (const paragraph of item.paragraphs) if (!paragraph || !Number.isInteger(paragraph.sourceParagraphIndex) || typeof paragraph.text !== "string" || typeof paragraph.isInTable !== "boolean") throw new Error("INVALID_WORKER_SNAPSHOT");
  return item as SerializableLocalDocumentSnapshot;
}

export class WpsHostBridge {
  private readonly operationCounts = new Map<string, number>();
  private lastOperationDetail: Record<string, JsonValue> = {};
  private descriptorIdentity: { document_token: string; full_name: string; paragraph_count: number; section_count: number } | null = null;
  private readonly recognitionJobs: WpsRecognitionJobService | null;
  private readonly previewBatches: WpsPreviewBatchService;
  private readonly formatTransactions = new WpsTransactionManager();
  private readonly formatExecutor = new WpsApiDocumentExecutor(undefined, new WpsCapabilityProvider(), undefined, this.formatTransactions, { yieldEvery: HOST_FORMAT_BATCH_LIMIT });
  private activeFormat: { job_id: string; document_token: string; transaction_id: string; executed_count: number } | null = null;
  constructor(private readonly application: WpsObject, private readonly diagnostics?: DiagnosticReporter, private readonly options: WpsHostBridgeOptions = {}) {
    this.recognitionJobs = options.recognitionExecutablePath ? new WpsRecognitionJobService(application, options.recognitionExecutablePath, options.maxRecognitionResultBytes, diagnostics, { statusPath: options.brokerStatusPath, jobsPath: options.brokerJobsPath, runtimeVersion: options.brokerRuntimeVersion, runtimeSha256: options.brokerRuntimeSha256, contractVersion: options.recognitionContractVersion, queueContractVersion: options.brokerQueueContractVersion, brokerVersion: options.brokerVersion, brokerExecutablePathHash: options.brokerExecutablePathHash, brokerExecutableSha256: options.brokerExecutableSha256 }) : null;
    this.previewBatches = new WpsPreviewBatchService(application, diagnostics);
  }

  async clearPreviewForCurrentDocument(): Promise<{ deleted_count: number; user_comment_integrity: true }> {
    this.diagnostics?.writeForComponent("wps-host-bridge", "INFO", "preview.cleanup.start", "开始清理当前文档的 Worker 预览批注", {});
    const descriptor = await this.captureDocumentDescriptor();
    let deleted = 0;
    try {
      for (;;) {
        const result = this.previewBatches.clear(descriptor.document_token, HOST_PREVIEW_BATCH_LIMIT) as { deleted_count?: number; remaining?: number; user_comment_integrity?: boolean };
        if (result.user_comment_integrity === false) throw new Error("PREVIEW_USER_COMMENT_CHANGED");
        deleted += Number(result.deleted_count ?? 0);
        if (Number(result.remaining ?? 0) === 0) {
          this.diagnostics?.writeForComponent("wps-host-bridge", "INFO", "preview.cleanup.completed", "当前文档的 Worker 预览批注已清理", { deleted_count: deleted, user_comment_integrity: true, document_token_suffix: descriptor.document_token.slice(-12) });
          return { deleted_count: deleted, user_comment_integrity: true };
        }
      }
    } catch (error) {
      this.diagnostics?.writeForComponent("wps-host-bridge", "ERROR", "preview.cleanup.failed", "当前文档的 Worker 预览批注清理失败", { stable_error_code: error instanceof Error ? error.message : "PREVIEW_CLEANUP_FAILED", deleted_count: deleted, document_token_suffix: descriptor.document_token.slice(-12) }, error);
      throw error;
    }
  }

  async handle(input: unknown): Promise<HostRpcResult> {
    const started = performance.now();
    let request: WorkerHostRequest;
    try { request = parseWorkerHostRequest(input); }
    catch (error) { return { type: "host.rpc.result", rpc_id: "invalid", job_id: "invalid", build_id: "invalid", ok: false, duration_ms: performance.now() - started, error: serialized(error) }; }
    try {
      this.lastOperationDetail = {};
      const value = await this.dispatch(request);
      const duration = performance.now() - started;
      const count = (this.operationCounts.get(request.operation) ?? 0) + 1;
      this.operationCounts.set(request.operation, count);
      if (count <= 3 || count % 20 === 0 || duration > 50) this.diagnostics?.writeForComponent("wps-host-bridge", duration > 50 ? "WARN" : "DEBUG", "host.rpc.duration", "WPS Host RPC 执行完成", { operation: request.operation, operation_count: count, duration_ms: duration, batch_size: request.operation === "host.read_paragraph_batch" ? Number(request.payload.batch_size ?? 0) : 0, ...this.lastOperationDetail });
      return { type: "host.rpc.result", rpc_id: request.rpc_id, job_id: request.job_id, build_id: request.build_id, ok: true, duration_ms: duration, value };
    } catch (error) {
      const duration = performance.now() - started;
      const detail = technicalDetail(error);
      this.diagnostics?.writeForComponent("wps-host-bridge", "ERROR", "host.rpc.failed", "WPS Host RPC 执行失败", { operation: request.operation, duration_ms: duration, stable_error_code: code(error), ...(detail ? { technical_detail: detail } : {}) }, error);
      return { type: "host.rpc.result", rpc_id: request.rpc_id, job_id: request.job_id, build_id: request.build_id, ok: false, duration_ms: duration, error: serialized(error) };
    }
  }

  private async dispatch(request: WorkerHostRequest): Promise<JsonValue> {
    if (request.operation === "host.capture_document_descriptor") return this.captureDocumentDescriptor();
    if (request.operation === "host.read_paragraph_batch") return this.readParagraphBatch(request);
    if (request.operation === "host.launch_recognition") return this.launchRecognition(request);
    if (request.operation === "host.probe_recognition") return this.probeRecognition(request);
    if (request.operation === "host.probe_shell_execute_one_argument") return this.probeShellExecuteOneArgument();
    if (request.operation === "host.cancel_recognition") return this.cancelRecognition(request);
    if (request.operation === "host.apply_preview_batch") return this.applyPreviewBatch(request);
    if (request.operation === "host.clear_preview_batch") return this.clearPreviewBatch(request);
    if (request.operation === "host.begin_transaction") return this.beginFormatTransaction(request);
    if (request.operation === "host.apply_format_batch") return this.applyFormatBatch(request);
    if (request.operation === "host.rollback_batch") return this.rollbackFormatTransaction(request);
    if (request.operation === "host.commit_transaction") return this.commitFormatTransaction(request);
    throw new Error("HOST_RPC_NOT_IMPLEMENTED");
  }

  private async captureDocumentDescriptor(): Promise<DocumentDescriptor & { [key: string]: JsonValue }> {
    const document = this.application.ActiveDocument as WpsObject | undefined;
    if (!document) throw new Error("NO_ACTIVE_DOCUMENT");
    const fullName = String(document.FullName ?? "");
    const pathHash = await sha256(fullName.toLocaleLowerCase());
    const paragraphCount = Number(document.Paragraphs?.Count ?? 0);
    const sectionCount = Number(document.Sections?.Count ?? 0);
    const tokenHash = await sha256(`${pathHash}:${paragraphCount}:${sectionCount}`);
    const documentToken = `doc-${tokenHash.slice(0, 32)}`;
    this.descriptorIdentity = { document_token: documentToken, full_name: fullName, paragraph_count: paragraphCount, section_count: sectionCount };
    return { document_token: documentToken, saved: document.Saved === true, local_docx_path: fullName, local_docx_path_hash: pathHash, paragraph_count: paragraphCount, section_count: sectionCount, extension: fullName.toLocaleLowerCase().endsWith(".docx") ? ".docx" : "" };
  }

  private validateDocumentToken(documentToken: string | undefined): { paragraph_count: number } {
    const expected = this.descriptorIdentity;
    const document = this.application.ActiveDocument as WpsObject | undefined;
    if (!expected || !document || documentToken !== expected.document_token) throw new Error("DOCUMENT_TOKEN_CHANGED");
    const fullName = String(document.FullName ?? "");
    const paragraphCount = Number(document.Paragraphs?.Count ?? 0);
    const sectionCount = Number(document.Sections?.Count ?? 0);
    if (fullName !== expected.full_name || paragraphCount !== expected.paragraph_count || sectionCount !== expected.section_count) throw new Error("DOCUMENT_TOKEN_CHANGED");
    return { paragraph_count: paragraphCount };
  }

  private async readParagraphBatch(request: WorkerHostRequest): Promise<Array<HostParagraphData & { [key: string]: JsonValue }>> {
    const startIndex = Number(request.payload.start_index);
    const batchSize = Number(request.payload.batch_size);
    if (!Number.isInteger(startIndex) || startIndex < 0 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > HOST_PARAGRAPH_BATCH_LIMIT) throw new Error("HOST_PARAGRAPH_BATCH_INVALID");
    const validationStarted = performance.now();
    const identity = this.validateDocumentToken(request.document_token);
    const validationDuration = performance.now() - validationStarted;
    if (startIndex >= identity.paragraph_count) return [];
    const end = Math.min(identity.paragraph_count, startIndex + batchSize);
    const values: Array<HostParagraphData & { [key: string]: JsonValue }> = [];
    let slowestApi = "host.validate_document_token";
    let slowestApiMs = validationDuration;
    for (let index = startIndex; index < end; index += 1) {
      let measured = performance.now();
      const paragraph = this.application.ActiveDocument.Paragraphs.Item(index + 1) as WpsObject;
      let elapsed = performance.now() - measured;
      if (elapsed > slowestApiMs) { slowestApi = "Paragraphs.Item"; slowestApiMs = elapsed; }
      measured = performance.now();
      const range = paragraph.Range as WpsObject;
      elapsed = performance.now() - measured;
      if (elapsed > slowestApiMs) { slowestApi = "Paragraph.Range"; slowestApiMs = elapsed; }
      measured = performance.now(); const rawText = stripWpsImplicitParagraphTerminator(range.Text); elapsed = performance.now() - measured;
      if (elapsed > slowestApiMs) { slowestApi = "Range.Text"; slowestApiMs = elapsed; }
      measured = performance.now(); const isInTable = Number(range.Tables?.Count ?? 0) > 0; elapsed = performance.now() - measured;
      if (elapsed > slowestApiMs) { slowestApi = "Range.Tables.Count"; slowestApiMs = elapsed; }
      measured = performance.now(); const rangeStart = Number(range.Start); const rangeEnd = Number(range.End); elapsed = performance.now() - measured;
      if (elapsed > slowestApiMs) { slowestApi = "Range.StartEnd"; slowestApiMs = elapsed; }
      values.push({ host_paragraph_index: index, raw_text: rawText, is_in_table: isInTable, range_start: rangeStart, range_end: rangeEnd });
    }
    this.lastOperationDetail = { start_index: startIndex, slowest_api: slowestApi, slowest_api_ms: slowestApiMs };
    return values;
  }

  private launchRecognition(request: WorkerHostRequest): JsonValue {
    this.validateDocumentToken(request.document_token);
    if (!this.recognitionJobs) throw new Error("LOCAL_RUNTIME_CONFIGURATION_REQUIRED");
    const input = snapshot(request.payload.snapshot);
    const sourcePath = String(request.payload.source_path ?? "");
    if (sourcePath !== input.localDocxPath || sourcePath !== this.descriptorIdentity?.full_name) throw new Error("DOCUMENT_TOKEN_CHANGED");
    if (Number(request.payload.contract_version) !== (this.options.recognitionContractVersion ?? 1)) throw new Error("RECOGNITION_CONTRACT_VERSION_MISMATCH");
    return this.recognitionJobs.launch(input) as unknown as JsonValue;
  }

  private probeRecognition(request: WorkerHostRequest): JsonValue {
    if (!this.recognitionJobs) throw new Error("LOCAL_RUNTIME_CONFIGURATION_REQUIRED");
    return this.recognitionJobs.probe(String(request.payload.recognition_job_id ?? "")) as unknown as JsonValue;
  }

  private probeShellExecuteOneArgument(): JsonValue {
    if (!this.options.enableDebugProbes) throw new Error("HOST_DEBUG_PROBE_DISABLED");
    const executablePath = this.options.probeExecutablePath;
    if (!executablePath) throw new Error("LOCAL_LAUNCH_PROBE_CONFIGURATION_REQUIRED");
    const fs = this.application.FileSystem;
    if (!fs || !new WpsLocalFileSystem(fs).exists(executablePath)) throw new Error("LOCAL_LAUNCH_PROBE_NOT_FOUND");
    const shellExecute = this.application.OAAssist?.ShellExecute;
    if (typeof shellExecute !== "function") throw new Error("LOCAL_PROCESS_EXECUTION_BLOCKED");
    const started = performance.now();
    this.diagnostics?.writeForComponent("wps-launch-probe", "INFO", "launch_probe.shell_execute.call.start", "准备调用单参数 ShellExecute 启动边界探针", {});
    try {
      // The one-argument form is the subject of this probe. Do not add an
      // empty, undefined or options parameter: WPS blocks on the two-argument
      // recognition form in the current host.
      shellExecute.call(this.application.OAAssist, executablePath);
      const returnedInMs = performance.now() - started;
      this.diagnostics?.writeForComponent("wps-launch-probe", "INFO", "launch_probe.shell_execute.call.returned", "单参数 ShellExecute 已返回", { returned_in_ms: returnedInMs });
      return { returned_in_ms: returnedInMs };
    } catch (error) {
      const returnedInMs = performance.now() - started;
      this.diagnostics?.writeForComponent("wps-launch-probe", "ERROR", "launch_probe.shell_execute.call.failed", "单参数 ShellExecute 调用失败", { returned_in_ms: returnedInMs }, error);
      throw error;
    }
  }

  private cancelRecognition(request: WorkerHostRequest): JsonValue {
    if (!this.recognitionJobs) throw new Error("LOCAL_RUNTIME_CONFIGURATION_REQUIRED");
    return { cancelled: this.recognitionJobs.cancel(String(request.payload.recognition_job_id ?? "")) };
  }

  private async applyPreviewBatch(request: WorkerHostRequest): Promise<JsonValue> {
    this.validateDocumentToken(request.document_token);
    const items = request.payload.items;
    if (!Array.isArray(items) || items.length < 1 || items.length > HOST_PREVIEW_BATCH_LIMIT) throw new Error("HOST_PREVIEW_BATCH_INVALID");
    return this.previewBatches.apply(String(request.document_token ?? ""), String(request.payload.session_id ?? ""), items as unknown as PreviewPlanItem[]);
  }

  private clearPreviewBatch(request: WorkerHostRequest): JsonValue {
    this.validateDocumentToken(request.document_token);
    return this.previewBatches.clear(String(request.document_token ?? ""), Number(request.payload.batch_size));
  }

  private beginFormatTransaction(request: WorkerHostRequest): JsonValue {
    this.validateDocumentToken(request.document_token);
    if (this.activeFormat) throw new Error("FORMAT_TRANSACTION_BUSY");
    const transactionId = this.formatTransactions.begin();
    this.activeFormat = { job_id: request.job_id, document_token: String(request.document_token), transaction_id: transactionId, executed_count: 0 };
    return { transaction_id: transactionId };
  }

  private async applyFormatBatch(request: WorkerHostRequest): Promise<JsonValue> {
    this.validateDocumentToken(request.document_token);
    const active = this.activeFormat;
    const commandSet = request.payload.command_set as unknown as FormattingCommandSet;
    if (!active || active.job_id !== request.job_id || active.document_token !== request.document_token || active.transaction_id !== request.payload.transaction_id) throw new Error("FORMAT_TRANSACTION_MISMATCH");
    assertFormattingCommandSet(commandSet, commandSet.request_id);
    if (commandSet.commands.length < 1 || commandSet.commands.length > HOST_FORMAT_BATCH_LIMIT) throw new Error("HOST_FORMAT_BATCH_INVALID");
    const result = await this.formatExecutor.execute(commandSet, active.transaction_id, String(request.payload.document_revision ?? ""));
    if (result.failed_command_id || result.rolled_back) {
      this.activeFormat = null;
      throw new Error(result.warnings[0] ?? "WPS_API_EXECUTION_FAILED");
    }
    active.executed_count += result.executed_command_ids.length;
    return { executed_count: result.executed_command_ids.length, total_executed_count: active.executed_count };
  }

  private rollbackFormatTransaction(request: WorkerHostRequest): JsonValue {
    const active = this.activeFormat;
    if (!active || active.job_id !== request.job_id || active.transaction_id !== request.payload.transaction_id) return { rolled_back: false };
    const rolledBack = this.formatTransactions.rollback(active.transaction_id) && this.formatTransactions.verifyRollback(active.transaction_id);
    this.activeFormat = null;
    return { rolled_back: rolledBack };
  }

  private commitFormatTransaction(request: WorkerHostRequest): JsonValue {
    this.validateDocumentToken(request.document_token);
    const active = this.activeFormat;
    if (!active || active.job_id !== request.job_id || active.document_token !== request.document_token || active.transaction_id !== request.payload.transaction_id) throw new Error("FORMAT_TRANSACTION_MISMATCH");
    this.formatTransactions.commit(active.transaction_id);
    const executedCount = active.executed_count;
    this.activeFormat = null;
    return { committed: true, executed_count: executedCount };
  }
}
