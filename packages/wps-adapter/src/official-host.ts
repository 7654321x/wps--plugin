import { CLIENT_CAPABILITIES_VERSION, EXECUTION_RESULT_VERSION, assertFormattingCommandSet, type ClientCapabilities, type ExecutionResult, type FormattingCommand, type FormattingCommandSet, type SetPageSetupArguments } from "../../contracts/src/index.js";
import type { CapabilityProvider, DocumentExecutor, DocumentReader, FontCapability, FontCapabilityProvider, TransactionManager } from "../../application/src/ports.js";
import type { LocalDocumentSnapshot } from "../../recognition-client/src/index.js";
import type { DiagnosticReporter } from "../../diagnostics/src/index.js";
import { WpsUnitConverter } from "./format-validation.js";
import { DEFAULT_GRID_MODE, DocumentGridCapabilityProvider, GridReadbackValidator, type GridCapability, type GridMode } from "./grid.js";
import { rawSliceUtf16, stripWpsImplicitParagraphTerminator } from "./host-text.js";

type WpsObject = Record<string, any>;
const SHA256 = /^[a-f0-9]{64}$/;

function normalizeText(value: unknown): string {
  // WPS appends an implicit paragraph/cell terminator.  Preserve all other
  // raw display characters for host-text-v1; canonicalization happens only
  // in the explicit binding/Range verification path.
  return stripWpsImplicitParagraphTerminator(value);
}
async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}
function app(): WpsObject {
  const candidate = (globalThis as { Application?: unknown }).Application;
  if (!candidate || typeof candidate !== "object") throw new Error("WPS_API_UNSUPPORTED");
  return candidate as WpsObject;
}
function paragraphAt(document: WpsObject, index: number): WpsObject {
  const paragraph = document.Paragraphs.Item(index + 1) as WpsObject;
  if (!paragraph || !paragraph.Range) throw new Error("TARGET_NOT_FOUND");
  return paragraph;
}
function sectionPageSetups(document: WpsObject, fallback: WpsObject): WpsObject[] {
  const count = Number(document.Sections?.Count ?? 0);
  if (!count || typeof document.Sections?.Item !== "function") return [fallback];
  const setups: WpsObject[] = [];
  for (let index = 1; index <= count; index += 1) {
    const setup = document.Sections.Item(index)?.PageSetup as WpsObject | undefined;
    if (!setup) throw new Error("SECTION_PAGE_SETUP_UNREADABLE");
    setups.push(setup);
  }
  return setups;
}
function sectionTarget(args: SetPageSetupArguments, setup: WpsObject): { width: number; height: number; top: number; bottom: number; left: number; right: number } {
  const landscape = Number(setup.Orientation) === 1;
  const value = (centimeters: number) => WpsUnitConverter.centimetersToPoints(centimeters);
  if (!landscape) return { width: value(args.page_width_cm), height: value(args.page_height_cm), top: value(args.margin_top_cm), bottom: value(args.margin_bottom_cm), left: value(args.margin_left_cm), right: value(args.margin_right_cm) };
  // Preserve horizontal sections and rotate physical page edges exactly like
  // the root DOCX engine: horizontal top=portrait left, etc.
  return { width: value(args.page_height_cm), height: value(args.page_width_cm), top: value(args.margin_left_cm), bottom: value(args.margin_right_cm), left: value(args.margin_bottom_cm), right: value(args.margin_top_cm) };
}

async function activeRevision(): Promise<string> {
  const document = app().ActiveDocument as WpsObject | undefined;
  if (!document) throw new Error("NO_ACTIVE_DOCUMENT");
  const count = Number(document.Paragraphs?.Count ?? 0);
  const text: string[] = [];
  for (let index = 0; index < count; index += 1) text.push(normalizeText(paragraphAt(document, index).Range.Text));
  const sourceSha256 = await sha256(text.join("\u001f"));
  return sourceSha256 + ":" + count;
}
function property(value: unknown): string { return value === undefined || value === null ? "" : String(value); }
async function formattingRevision(document: WpsObject, count: number, diagnostics?: DiagnosticReporter): Promise<string> {
  const started = Date.now();
  diagnostics?.writeForComponent("wps-document-reader", "INFO", "snapshot.formatting_revision.start", "开始读取文档格式修订信息", { paragraph_count: count });
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const range = paragraphAt(document, index).Range as WpsObject;
    const font = range.Font as WpsObject | undefined; const format = range.ParagraphFormat as WpsObject | undefined;
    values.push([font?.NameAscii, font?.NameOther, font?.NameFarEast, font?.Size, font?.Bold, format?.Alignment, format?.CharacterUnitFirstLineIndent, format?.CharacterUnitLeftIndent, format?.CharacterUnitRightIndent, format?.LineUnitBefore, format?.LineUnitAfter, format?.LineSpacingRule, format?.LineSpacing, format?.PageBreakBefore, format?.OutlineLevel].map(property).join("\u001e"));
    if ((index + 1) % 20 === 0 || index + 1 === count) diagnostics?.writeForComponent("wps-document-reader", "DEBUG", "snapshot.formatting_revision.progress", "文档格式修订读取进度", { completed: index + 1, total: count, duration_ms: Date.now() - started });
  }
  const sections = Number(document.Sections?.Count ?? 0);
  for (let index = 1; index <= sections; index += 1) { const page = document.Sections.Item(index)?.PageSetup as WpsObject | undefined; values.push([page?.PageWidth, page?.PageHeight, page?.TopMargin, page?.BottomMargin, page?.LeftMargin, page?.RightMargin, page?.Orientation].map(property).join("\u001e")); }
  const revision = await sha256(values.join("\u001f"));
  diagnostics?.writeForComponent("wps-document-reader", "INFO", "snapshot.formatting_revision.complete", "文档格式修订信息读取完成", { paragraph_count: count, duration_ms: Date.now() - started });
  return revision;
}

export interface RuntimeProbeItem {
  api: string; supported: boolean; readable: boolean; writable: boolean;
  official_type_confirmed: boolean; real_host_confirmed: boolean; error_code?: string;
}

export class WpsRuntimeProbe {
  constructor(private readonly application?: WpsObject) {}
  probe(): RuntimeProbeItem[] {
    try {
      const application = this.application ?? app();
      const document = application.ActiveDocument as WpsObject | undefined;
      const paragraph = document?.Paragraphs?.Count ? paragraphAt(document, 0) : undefined;
      const range = paragraph?.Range as WpsObject | undefined;
      const comments = document?.Comments as WpsObject | undefined;
      return [
        ["Application", true, true],
        ["Application.ActiveDocument", !!document, !!document],
        ["Document.IsDocx", typeof document?.FullName === "string" && document.FullName.toLowerCase().endsWith(".docx"), typeof document?.FullName === "string"],
        ["Document.Saved", typeof document?.Saved === "boolean", typeof document?.Saved === "boolean"],
        ["Document.Paragraphs", !!document?.Paragraphs, !!document?.Paragraphs],
        ["Paragraph.Range.Text", !!range, typeof range?.Text === "string"],
        ["Range.Font", !!range?.Font, !!range?.Font],
        ["Range.ParagraphFormat", !!range?.ParagraphFormat, !!range?.ParagraphFormat],
        ["Range.PageSetup", !!range?.PageSetup, !!range?.PageSetup],
        ["Document.Comments", !!comments, !!comments],
        ["Comments.Add", typeof comments?.Add === "function", typeof comments?.Add === "function"],
        ["Application.CreateTaskPane", typeof application.CreateTaskPane === "function", false],
        ["Application.ApiEvent", !!application.ApiEvent, false],
      ].map(([api, supported, readable]) => ({
        api: String(api), supported: Boolean(supported), readable: Boolean(readable),
        // A property lookup never proves that WPS permits a write.  This becomes true
        // only after the dedicated disposable-document probe has read it back.
        writable: false, official_type_confirmed: true, real_host_confirmed: false,
      }));
    } catch {
      return [{ api: "Application", supported: false, readable: false, writable: false, official_type_confirmed: false, real_host_confirmed: false, error_code: "WPS_API_UNSUPPORTED" }];
    }
  }

  gridCapabilities(): GridCapability[] {
    try {
      const document = app().ActiveDocument as WpsObject | undefined;
      const range = document?.Paragraphs?.Count ? paragraphAt(document, 0).Range as WpsObject : undefined;
      return new DocumentGridCapabilityProvider().probe({ pageSetup: range?.PageSetup, paragraphFormat: range?.ParagraphFormat, font: range?.Font, sections: document?.Sections });
    } catch {
      return new DocumentGridCapabilityProvider().probe();
    }
  }
}

export class WpsCapabilityProvider {
  capabilities(): ClientCapabilities {
    const report = new WpsRuntimeProbe().probe();
    // A WPS property is only promoted after the executor itself writes and
    // reads it back in the same transaction.  Requiring a speculative probe
    // beforehand made the formal Ribbon path unreachable in a real host.
    const has = (name: string) => report.some((item) => item.api === name && item.supported && item.readable);
    return {
      schema_version: CLIENT_CAPABILITIES_VERSION,
      capabilities: [
        ...(has("Range.Font") ? ["paragraph.font" as const] : []),
        ...(has("Range.ParagraphFormat") ? ["paragraph.alignment" as const, "paragraph.indent" as const, "paragraph.spacing" as const] : []),
        ...(has("Range.PageSetup") ? ["section.page_setup" as const] : []),
      ],
    };
  }
}

/** Reads names only; no font file is opened, copied, uploaded or emitted. */
export class WpsFontCapabilityProvider implements FontCapabilityProvider {
  constructor(private readonly application?: WpsObject) {}
  inspect(fontNames: string[]): FontCapability[] {
    const requested = [...new Set(fontNames.filter(Boolean))];
    let names: string[] | null = null;
    try {
      const collection = (this.application ?? app()).FontNames as WpsObject | undefined;
      const count = Number(collection?.Count ?? 0);
      if (collection && count >= 0 && typeof collection.Item === "function") {
        names = [];
        for (let index = 1; index <= count; index += 1) names.push(String(collection.Item(index).Name ?? collection.Item(index)));
      }
    } catch { names = null; }
    return requested.map((font) => {
      const normalized = font.trim().toLocaleLowerCase();
      const match = names?.find((name) => name.trim().toLocaleLowerCase() === normalized) ?? null;
      return { requested_font: font, normalized_font: normalized, installed: match !== null, matched_name: match, source: names ? "Application.FontNames" : "WPS_FONT_ENUMERATION_UNAVAILABLE" };
    });
  }
  assertAvailable(fontNames: string[]): void {
    const missing = this.inspect(fontNames).find((item) => !item.installed);
    if (missing) throw new Error("FONT_NOT_INSTALLED");
  }
}

export class WpsDocumentReader implements DocumentReader {
  constructor(private readonly diagnostics?: DiagnosticReporter) {}
  async readSnapshot(options: { allowUnsaved?: boolean } = {}): Promise<LocalDocumentSnapshot> {
    const started = Date.now();
    this.diagnostics?.writeForComponent("wps-document-reader", "INFO", "snapshot.start", "开始读取 WPS 文档快照", {});
    const document = app().ActiveDocument as WpsObject | undefined;
    if (!document) throw new Error("NO_ACTIVE_DOCUMENT");
    if ((!document.Saved && !options.allowUnsaved) || typeof document.FullName !== "string" || !document.FullName.toLowerCase().endsWith(".docx")) {
      throw new Error("DOCUMENT_MUST_BE_SAVED");
    }
    const paragraphs: Array<{ sourceParagraphIndex: number; text: string; isInTable?: boolean }> = [];
    const count = Number(document.Paragraphs?.Count ?? 0);
    const paragraphStarted = Date.now();
    this.diagnostics?.writeForComponent("wps-document-reader", "INFO", "snapshot.paragraphs.start", "开始读取 WPS 段落", { paragraph_count: count });
    for (let index = 0; index < count; index += 1) {
      const range = paragraphAt(document, index).Range as WpsObject;
      paragraphs.push({ sourceParagraphIndex: index, text: normalizeText(range.Text), isInTable: Number(range.Tables?.Count ?? 0) > 0 });
      if ((index + 1) % 20 === 0 || index + 1 === count) this.diagnostics?.writeForComponent("wps-document-reader", "DEBUG", "snapshot.paragraphs.progress", "WPS 段落读取进度", { completed: index + 1, total: count, duration_ms: Date.now() - paragraphStarted });
    }
    this.diagnostics?.writeForComponent("wps-document-reader", "INFO", "snapshot.paragraphs.complete", "WPS 段落读取完成", { paragraph_count: count, duration_ms: Date.now() - paragraphStarted });
    const sourceSha256 = await sha256(paragraphs.map((item) => item.text).join("\u001f"));
    const orderHash = await sha256(paragraphs.map((item) => `${item.sourceParagraphIndex}:${item.text}`).join("\u001f"));
    const documentFullNameHash = await sha256(String(document.FullName).toLocaleLowerCase());
    const snapshot: LocalDocumentSnapshot = {
      documentId: "wps-" + sourceSha256.slice(0, 16),
      revision: sourceSha256 + ":" + count,
      sourceSha256, localDocxPath: document.FullName, paragraphs, paragraphOrderHash: orderHash,
      sectionCount: Number(document.Sections?.Count ?? 0), formattingRevision: await formattingRevision(document, count, this.diagnostics), documentFullNameHash,
    };
    this.diagnostics?.writeForComponent("wps-document-reader", "INFO", "snapshot.complete", "WPS 文档快照读取完成", { paragraph_count: count, duration_ms: Date.now() - started });
    return snapshot;
  }
}

/** One transaction owns capture, reverse rollback and the post-rollback check. */
export class WpsFormattingTransaction {
  private readonly journals = new Map<string, Array<() => void>>();
  begin(transactionId: string): void { this.journals.set(transactionId, []); }
  capture(transactionId: string, restore: () => void): void {
    // Direct executor contract tests may supply an externally generated id.
    // The production use case always begins first; this fallback still keeps
    // a single journal rather than creating an executor-local restore stack.
    if (!this.journals.has(transactionId)) this.begin(transactionId);
    const journal = this.journals.get(transactionId)!;
    journal.push(restore);
  }
  commit(transactionId: string): void { this.journals.delete(transactionId); }
  rollback(transactionId: string): boolean {
    const journal = this.journals.get(transactionId);
    if (!journal) return true;
    try { for (const restore of journal.reverse()) restore(); this.journals.delete(transactionId); return true; }
    catch { return false; }
  }
  verifyRollback(transactionId: string): boolean { return !this.journals.has(transactionId); }
}

export class WpsTransactionManager implements TransactionManager {
  private sequence = 0;
  readonly transaction = new WpsFormattingTransaction();
  begin(): string { this.sequence += 1; const id = "wps-format-tx-" + this.sequence; this.transaction.begin(id); return id; }
  capture(transactionId: string, restore: () => void): void { this.transaction.capture(transactionId, restore); }
  commit(transactionId: string): void { this.transaction.commit(transactionId); }
  rollback(transactionId: string): boolean { return this.transaction.rollback(transactionId); }
  verifyRollback(transactionId: string): boolean { return this.transaction.verifyRollback(transactionId); }
}

export class WpsTargetLocator {
  async locate(target: FormattingCommand["target"]): Promise<{ paragraph: WpsObject; range: WpsObject }> {
    if (!SHA256.test(target.text_sha256) || !SHA256.test(target.host_raw_text_sha256)) throw new Error("HOST_RANGE_HASH_MISMATCH");
    const document = app().ActiveDocument as WpsObject;
    const selected = paragraphAt(document, target.host_paragraph_index);
    const rawText = normalizeText(selected.Range.Text);
    if (await sha256(rawText) !== target.host_raw_text_sha256) throw new Error("PARAGRAPH_CHANGED");
    const fragment = rawSliceUtf16(rawText, target.host_raw_start_utf16, target.host_raw_end_utf16);
    if (fragment === null) throw new Error("HOST_RANGE_OUT_OF_BOUNDS");
    if (await sha256(fragment) !== target.text_sha256) throw new Error("HOST_RANGE_HASH_MISMATCH");
    const paragraphStart = Number(selected.Range.Start);
    const start = paragraphStart + target.host_raw_start_utf16;
    const end = paragraphStart + target.host_raw_end_utf16;
    if (!Number.isFinite(paragraphStart) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("HOST_RANGE_OUT_OF_BOUNDS");
    const range = document.Range(start, end) as WpsObject;
    const readback = normalizeText(range.Text);
    if (await sha256(readback) !== target.text_sha256) throw new Error("HOST_RANGE_TEXT_MISMATCH");
    return { paragraph: selected, range };
  }
}

const alignment: Record<string, number> = { left: 0, center: 1, right: 2, justify: 3, distributed: 4 };

export interface WpsExecutionOptions { yieldEvery?: number; }

function yieldToHost(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export class WpsApiDocumentExecutor implements DocumentExecutor {
  constructor(
    private readonly locator = new WpsTargetLocator(),
    private readonly capabilities: CapabilityProvider = new WpsCapabilityProvider(),
    private readonly gridMode: GridMode = DEFAULT_GRID_MODE,
    private readonly transaction = new WpsTransactionManager(),
    private readonly options: WpsExecutionOptions = {},
  ) {}
  async execute(commandSet: FormattingCommandSet, transactionId: string, revision: string): Promise<ExecutionResult> {
    const supported = new Set(this.capabilities.capabilities().capabilities);
    const executed: string[] = [];
    try {
      assertFormattingCommandSet(commandSet, commandSet.request_id);
      if (await activeRevision() !== revision) throw new Error("DOCUMENT_CHANGED");
      const yieldEvery = Math.max(1, this.options.yieldEvery ?? 15);
      for (let index = 0; index < commandSet.commands.length; index += 1) {
        const command = commandSet.commands[index];
        if ((index + 1) % yieldEvery === 0 && await activeRevision() !== revision) throw new Error("ACTIVE_DOCUMENT_CHANGED");
        if (!supported.has(command.required_capability)) throw new Error("CLIENT_CAPABILITY_MISSING");
        this.transaction.capture(transactionId, await this.apply(command));
        executed.push(command.command_id);
        if ((index + 1) % yieldEvery === 0) await yieldToHost();
      }
      // Page commands are emitted before the paragraph commands by the service.
      // Validate after the full formal chain, so natural run metrics and the
      // line-only paragraph policy have been applied before WPS readback.
      for (const command of commandSet.commands.filter((item) => item.kind === "section.set_page_setup")) {
        const relatedKinds = new Set(commandSet.commands.filter((item) => item.target.source_paragraph_index === command.target.source_paragraph_index).map((item) => item.kind));
        if (!["paragraph.set_font", "paragraph.set_alignment", "paragraph.set_spacing"].every((kind) => relatedKinds.has(kind as FormattingCommand["kind"]))) continue;
        const located = await this.locator.locate(command.target);
        this.validateGridReadback(located.range, command.arguments);
      }
      return { schema_version: EXECUTION_RESULT_VERSION, transaction_id: transactionId, executed_command_ids: executed, skipped_command_ids: [], failed_command_id: null, warnings: [], rolled_back: false, document_revision: revision };
    } catch (error) {
      const rolledBack = this.transaction.rollback(transactionId) && this.transaction.verifyRollback(transactionId);
      return { schema_version: EXECUTION_RESULT_VERSION, transaction_id: transactionId, executed_command_ids: executed, skipped_command_ids: [], failed_command_id: commandSet.commands[executed.length]?.command_id ?? null, warnings: [error instanceof Error ? error.message : "WPS_API_EXECUTION_FAILED", ...(rolledBack ? [] : ["ROLLBACK_FAILED"])], rolled_back: rolledBack, document_revision: revision };
    }
  }
  private async apply(command: FormattingCommand): Promise<() => void> {
    const located = await this.locator.locate(command.target);
    const range = located.range;
    if (command.kind === "paragraph.set_font") {
      const args = command.arguments;
      const font = range.Font as WpsObject;
      const before = { NameAscii: font.NameAscii, NameOther: font.NameOther, NameFarEast: font.NameFarEast, Size: font.Size, Bold: font.Bold, Spacing: font.Spacing, Scaling: font.Scaling, DisableCharacterSpaceGrid: font.DisableCharacterSpaceGrid };
      const latin = args.latin_font_name; const east = args.east_asia_font_name;
      font.NameAscii = latin; font.NameOther = latin; font.NameFarEast = east; font.Size = args.font_size_pt; font.Bold = args.bold ? 1 : 0;
      // Explicitly neutralize direct character scaling/spacing.  This is
      // independent from paragraph alignment and keeps titles and body text
      // at natural 100% glyph width even in documents that previously used a
      // character grid.
      font.Spacing = 0; font.Scaling = 100; font.DisableCharacterSpaceGrid = true;
      if (font.NameAscii !== latin || font.NameOther !== latin || font.NameFarEast !== east || !WpsUnitConverter.close(Number(font.Size), Number(args.font_size_pt)) || Boolean(font.Bold) !== args.bold || !WpsUnitConverter.close(Number(font.Spacing), 0) || !WpsUnitConverter.close(Number(font.Scaling), 100) || !Boolean(font.DisableCharacterSpaceGrid)) throw new Error("WRITE_READBACK_MISMATCH");
      return () => { Object.assign(font, before); };
    } else if (command.kind === "paragraph.set_alignment") {
      const args = command.arguments;
      const format = range.ParagraphFormat as WpsObject; const before = format.Alignment;
      format.Alignment = alignment[String(args.alignment)];
      if (format.Alignment !== alignment[String(args.alignment)]) throw new Error("WRITE_READBACK_MISMATCH");
      return () => { format.Alignment = before; };
    } else if (command.kind === "paragraph.set_indent") {
      const args = command.arguments;
      const format = range.ParagraphFormat as WpsObject;
      const before = { CharacterUnitFirstLineIndent: format.CharacterUnitFirstLineIndent, CharacterUnitLeftIndent: format.CharacterUnitLeftIndent, CharacterUnitRightIndent: format.CharacterUnitRightIndent };
      format.CharacterUnitFirstLineIndent = args.first_line_indent_chars;
      format.CharacterUnitLeftIndent = args.left_indent_chars; format.CharacterUnitRightIndent = args.right_indent_chars;
      if (format.CharacterUnitFirstLineIndent !== args.first_line_indent_chars || format.CharacterUnitLeftIndent !== args.left_indent_chars || format.CharacterUnitRightIndent !== args.right_indent_chars) throw new Error("WRITE_READBACK_MISMATCH");
      return () => { Object.assign(format, before); };
    } else if (command.kind === "paragraph.set_spacing") {
      const args = command.arguments;
      const format = range.ParagraphFormat as WpsObject;
      const before = { LineUnitBefore: format.LineUnitBefore, LineUnitAfter: format.LineUnitAfter, LineSpacingRule: format.LineSpacingRule, LineSpacing: format.LineSpacing, PageBreakBefore: format.PageBreakBefore, OutlineLevel: format.OutlineLevel, SnapToGrid: format.SnapToGrid };
      const beforeLines = Number(args.space_before_lines); const afterLines = Number(args.space_after_lines); const outlineLevel = Number(args.outline_level ?? 10);
      format.LineSpacingRule = 4; format.LineSpacing = args.line_spacing_pt; format.LineUnitBefore = beforeLines; format.LineUnitAfter = afterLines; format.PageBreakBefore = args.page_break_before ? 1 : 0; format.OutlineLevel = outlineLevel; format.SnapToGrid = false;
      if (!WpsUnitConverter.close(Number(format.LineUnitBefore), beforeLines) || !WpsUnitConverter.close(Number(format.LineUnitAfter), afterLines) || Number(format.LineSpacingRule) !== 4 || !WpsUnitConverter.close(Number(format.LineSpacing), Number(args.line_spacing_pt)) || Boolean(format.PageBreakBefore) !== Boolean(args.page_break_before) || Number(format.OutlineLevel) !== outlineLevel || Boolean(format.SnapToGrid)) throw new Error("WRITE_READBACK_MISMATCH");
      return () => { Object.assign(format, before); };
    } else if (command.kind === "section.set_page_setup") {
      const args = command.arguments;
      const document = app().ActiveDocument as WpsObject;
      const setups = sectionPageSetups(document, range.PageSetup as WpsObject);
      const before = setups.map((setup) => ({ setup, PageWidth: setup.PageWidth, PageHeight: setup.PageHeight, TopMargin: setup.TopMargin, BottomMargin: setup.BottomMargin, LeftMargin: setup.LeftMargin, RightMargin: setup.RightMargin, LinesPage: setup.LinesPage, CharsLine: setup.CharsLine, LayoutMode: setup.LayoutMode, ShowGrid: setup.ShowGrid }));
      const mode = args.grid_mode;
      if (mode === "strict_lines_and_chars") new GridReadbackValidator().assertStrictSupported();
      const restoreAll = () => {
        for (const item of before.reverse()) {
          item.setup.PageWidth = item.PageWidth; item.setup.PageHeight = item.PageHeight;
          item.setup.TopMargin = item.TopMargin; item.setup.BottomMargin = item.BottomMargin;
          item.setup.LeftMargin = item.LeftMargin; item.setup.RightMargin = item.RightMargin;
          item.setup.LinesPage = item.LinesPage; item.setup.CharsLine = item.CharsLine;
          item.setup.LayoutMode = item.LayoutMode; item.setup.ShowGrid = item.ShowGrid;
        }
      };
      try {
        for (const setup of setups) {
          const target = sectionTarget(args, setup);
          setup.PageWidth = target.width; setup.PageHeight = target.height;
          setup.TopMargin = target.top; setup.BottomMargin = target.bottom; setup.LeftMargin = target.left; setup.RightMargin = target.right;
          // line_only deliberately does not write LinesPage or CharsLine.
          setup.LayoutMode = 0; setup.ShowGrid = false;
          if (!WpsUnitConverter.close(setup.PageWidth, target.width) || !WpsUnitConverter.close(setup.PageHeight, target.height) || !WpsUnitConverter.close(setup.TopMargin, target.top) || !WpsUnitConverter.close(setup.BottomMargin, target.bottom) || !WpsUnitConverter.close(setup.LeftMargin, target.left) || !WpsUnitConverter.close(setup.RightMargin, target.right)) throw new Error("WRITE_READBACK_MISMATCH");
        }
      } catch (error) { restoreAll(); throw error; }
      return restoreAll;
    } else throw new Error("COMMAND_NOT_ALLOWED");
  }
  private validateGridReadback(range: WpsObject, args: SetPageSetupArguments): void {
    const setup = range.PageSetup as WpsObject;
    const format = range.ParagraphFormat as WpsObject;
    const font = range.Font as WpsObject;
    const mode = args.grid_mode;
    const actualAlignment = Object.entries(alignment).find(([, value]) => value === Number(format.Alignment))?.[0] ?? "left";
    const readback = {
      mode, pageWidthPt: Number(setup.PageWidth), pageHeightPt: Number(setup.PageHeight), topMarginPt: Number(setup.TopMargin), bottomMarginPt: Number(setup.BottomMargin), leftMarginPt: Number(setup.LeftMargin), rightMarginPt: Number(setup.RightMargin), landscape: Number(setup.Orientation) === 1,
      layoutMode: Number(setup.LayoutMode), showGrid: Boolean(setup.ShowGrid), charsLine: Number(setup.CharsLine), linesPage: Number(setup.LinesPage), snapToGrid: Boolean(format.SnapToGrid), characterSpacingPt: Number(font.Spacing), characterScalingPercent: Number(font.Scaling), fitText: false, alignment: actualAlignment as "left" | "center" | "right" | "justify" | "distributed",
    };
    const validator = new GridReadbackValidator();
    if (mode === "strict_lines_and_chars") validator.assertStrictSupported();
    validator.validateLineOnly(readback);
  }
}
