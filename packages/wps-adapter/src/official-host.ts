import { PROTOCOL_VERSION, assertFormattingCommandSet, type ClientCapabilities, type ExecutionResult, type FormattingCommand, type FormattingCommandSet } from "../../contracts/src/index.js";
import type { CapabilityProvider, DocumentExecutor, DocumentReader, TransactionManager } from "../../application/src/ports.js";
import type { LocalDocumentSnapshot } from "../../recognition-client/src/index.js";
import { WpsUnitConverter } from "./format-validation.js";
import { DEFAULT_GRID_MODE, DocumentGridCapabilityProvider, GridReadbackValidator, type GridCapability, type GridMode } from "./grid.js";

type WpsObject = Record<string, any>;
const SHA256 = /^[a-f0-9]{64}$/;

function normalizeText(value: unknown): string {
  // WPS appends paragraph, manual-line-break and section/page-break control
  // characters to Range.Text. python-docx paragraph.text excludes them.
  return String(value ?? "").replace(/[\r\n\v\f]+$/g, "");
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

async function activeRevision(): Promise<string> {
  const document = app().ActiveDocument as WpsObject | undefined;
  if (!document) throw new Error("NO_ACTIVE_DOCUMENT");
  const count = Number(document.Paragraphs?.Count ?? 0);
  const text: string[] = [];
  for (let index = 0; index < count; index += 1) text.push(normalizeText(paragraphAt(document, index).Range.Text));
  const sourceSha256 = await sha256(text.join("\u001f"));
  return sourceSha256 + ":" + count + ":" + String(document.Saved);
}

export interface RuntimeProbeItem {
  api: string; supported: boolean; readable: boolean; writable: boolean;
  official_type_confirmed: boolean; real_host_confirmed: boolean; error_code?: string;
}

export class WpsRuntimeProbe {
  probe(): RuntimeProbeItem[] {
    try {
      const application = app();
      const document = application.ActiveDocument as WpsObject | undefined;
      const paragraph = document?.Paragraphs?.Count ? paragraphAt(document, 0) : undefined;
      const range = paragraph?.Range as WpsObject | undefined;
      return [
        ["Application.ActiveDocument", !!document, !!document],
        ["Document.Paragraphs", !!document?.Paragraphs, !!document?.Paragraphs],
        ["Paragraph.Range.Text", !!range, typeof range?.Text === "string"],
        ["Range.Font", !!range?.Font, !!range?.Font],
        ["Range.ParagraphFormat", !!range?.ParagraphFormat, !!range?.ParagraphFormat],
        ["Range.PageSetup", !!range?.PageSetup, !!range?.PageSetup],
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
      schema_version: PROTOCOL_VERSION,
      capabilities: [
        ...(has("Range.Font") ? ["paragraph.font" as const] : []),
        ...(has("Range.ParagraphFormat") ? ["paragraph.alignment" as const, "paragraph.indent" as const, "paragraph.spacing" as const] : []),
        ...(has("Range.PageSetup") ? ["section.page_setup" as const] : []),
      ],
    };
  }
}

export class WpsDocumentReader implements DocumentReader {
  async readSnapshot(): Promise<LocalDocumentSnapshot> {
    const document = app().ActiveDocument as WpsObject | undefined;
    if (!document) throw new Error("NO_ACTIVE_DOCUMENT");
    if (!document.Saved || typeof document.FullName !== "string" || !document.FullName.toLowerCase().endsWith(".docx")) {
      throw new Error("DOCUMENT_MUST_BE_SAVED");
    }
    const paragraphs: Array<{ sourceParagraphIndex: number; text: string }> = [];
    const count = Number(document.Paragraphs?.Count ?? 0);
    for (let index = 0; index < count; index += 1) {
      paragraphs.push({ sourceParagraphIndex: index, text: normalizeText(paragraphAt(document, index).Range.Text) });
    }
    const sourceSha256 = await sha256(paragraphs.map((item) => item.text).join("\u001f"));
    return {
      documentId: "wps-" + sourceSha256.slice(0, 16),
      revision: sourceSha256 + ":" + count + ":" + String(document.Saved),
      sourceSha256, localDocxPath: document.FullName, paragraphs,
    };
  }
}

/** The executor owns the WPS restore journal; this manager records use-case state. */
export class WpsTransactionManager implements TransactionManager {
  private sequence = 0;
  begin(): string { this.sequence += 1; return "wps-grid-tx-" + this.sequence; }
  commit(_transactionId: string): void { /* WPS state is already committed by the executor. */ }
  rollback(_transactionId: string): void { /* The executor has already restored its reverse journal. */ }
}

export class WpsTargetLocator {
  async locate(target: FormattingCommand["target"]): Promise<WpsObject> {
    if (!SHA256.test(target.text_sha256)) throw new Error("TARGET_HASH_MISMATCH");
    const document = app().ActiveDocument as WpsObject;
    const direct = paragraphAt(document, target.source_paragraph_index);
    if (await sha256(normalizeText(direct.Range.Text)) === target.text_sha256) return direct;
    const count = Number(document.Paragraphs?.Count ?? 0);
    const start = Math.max(0, target.source_paragraph_index - 3);
    const end = Math.min(count, target.source_paragraph_index + 4);
    const matches: WpsObject[] = [];
    for (let index = start; index < end; index += 1) {
      const candidate = paragraphAt(document, index);
      if (await sha256(normalizeText(candidate.Range.Text)) === target.text_sha256) matches.push(candidate);
    }
    if (matches.length > 1) throw new Error("TARGET_AMBIGUOUS");
    if (!matches.length) throw new Error("TARGET_NOT_FOUND");
    return matches[0];
  }
}

const alignment: Record<string, number> = { left: 0, center: 1, right: 2, justify: 3, distributed: 4 };

export class WpsApiDocumentExecutor implements DocumentExecutor {
  constructor(
    private readonly locator = new WpsTargetLocator(),
    private readonly capabilities: CapabilityProvider = new WpsCapabilityProvider(),
    private readonly gridMode: GridMode = DEFAULT_GRID_MODE,
  ) {}
  async execute(commandSet: FormattingCommandSet, transactionId: string, revision: string): Promise<ExecutionResult> {
    const supported = new Set(this.capabilities.capabilities().capabilities);
    const executed: string[] = [];
    const journal: Array<() => void> = [];
    try {
      assertFormattingCommandSet(commandSet, commandSet.request_id);
      if (await activeRevision() !== revision) throw new Error("DOCUMENT_CHANGED");
      for (const command of commandSet.commands) {
        if (!supported.has(command.required_capability)) throw new Error("CLIENT_CAPABILITY_MISSING");
        journal.push(await this.apply(command));
        executed.push(command.command_id);
      }
      // Page commands are emitted before the paragraph commands by the service.
      // Validate after the full formal chain, so natural run metrics and the
      // line-only paragraph policy have been applied before WPS readback.
      for (const command of commandSet.commands.filter((item) => item.kind === "section.set_page_setup")) {
        const relatedKinds = new Set(commandSet.commands.filter((item) => item.target.source_paragraph_index === command.target.source_paragraph_index).map((item) => item.kind));
        if (!["paragraph.set_font", "paragraph.set_alignment", "paragraph.set_spacing"].every((kind) => relatedKinds.has(kind as FormattingCommand["kind"]))) continue;
        const paragraph = await this.locator.locate(command.target);
        this.validateGridReadback(paragraph, command.arguments);
      }
      return { schema_version: PROTOCOL_VERSION, transaction_id: transactionId, executed_command_ids: executed, skipped_command_ids: [], failed_command_id: null, warnings: [], rolled_back: false, document_revision: revision };
    } catch (error) {
      let rolledBack = true;
      try { for (const restore of journal.reverse()) restore(); } catch { rolledBack = false; }
      return { schema_version: PROTOCOL_VERSION, transaction_id: transactionId, executed_command_ids: executed, skipped_command_ids: [], failed_command_id: commandSet.commands[executed.length]?.command_id ?? null, warnings: [error instanceof Error ? error.message : "WPS_API_EXECUTION_FAILED", ...(rolledBack ? [] : ["ROLLBACK_FAILED"])], rolled_back: rolledBack, document_revision: revision };
    }
  }
  private async apply(command: FormattingCommand): Promise<() => void> {
    const paragraph = await this.locator.locate(command.target);
    const args = command.arguments;
    if (command.kind === "paragraph.set_font") {
      const font = paragraph!.Range.Font as WpsObject;
      const before = { NameAscii: font.NameAscii, NameOther: font.NameOther, NameFarEast: font.NameFarEast, Size: font.Size, Bold: font.Bold, Spacing: font.Spacing, Scaling: font.Scaling, DisableCharacterSpaceGrid: font.DisableCharacterSpaceGrid };
      const latin = args.latin_font_name ?? args.font_family; const east = args.east_asia_font_name ?? args.font_family;
      font.NameAscii = latin; font.NameOther = latin; font.NameFarEast = east; font.Size = args.font_size_pt; font.Bold = args.bold ? 1 : 0;
      // Explicitly neutralize direct character scaling/spacing.  This is
      // independent from paragraph alignment and keeps titles and body text
      // at natural 100% glyph width even in documents that previously used a
      // character grid.
      font.Spacing = 0; font.Scaling = 100; font.DisableCharacterSpaceGrid = true;
      if (font.NameAscii !== latin || font.NameOther !== latin || font.NameFarEast !== east || !WpsUnitConverter.close(Number(font.Size), Number(args.font_size_pt)) || Boolean(font.Bold) !== args.bold || !WpsUnitConverter.close(Number(font.Spacing), 0) || !WpsUnitConverter.close(Number(font.Scaling), 100) || !Boolean(font.DisableCharacterSpaceGrid)) throw new Error("WRITE_READBACK_MISMATCH");
      return () => { Object.assign(font, before); };
    } else if (command.kind === "paragraph.set_alignment") {
      const format = paragraph!.Range.ParagraphFormat as WpsObject; const before = format.Alignment;
      format.Alignment = alignment[String(args.alignment)];
      if (format.Alignment !== alignment[String(args.alignment)]) throw new Error("WRITE_READBACK_MISMATCH");
      return () => { format.Alignment = before; };
    } else if (command.kind === "paragraph.set_indent") {
      const format = paragraph!.Range.ParagraphFormat as WpsObject;
      const before = { CharacterUnitFirstLineIndent: format.CharacterUnitFirstLineIndent, CharacterUnitLeftIndent: format.CharacterUnitLeftIndent, CharacterUnitRightIndent: format.CharacterUnitRightIndent };
      format.CharacterUnitFirstLineIndent = args.first_line_indent_chars;
      format.CharacterUnitLeftIndent = args.left_indent_chars; format.CharacterUnitRightIndent = args.right_indent_chars;
      if (format.CharacterUnitFirstLineIndent !== args.first_line_indent_chars || format.CharacterUnitLeftIndent !== args.left_indent_chars || format.CharacterUnitRightIndent !== args.right_indent_chars) throw new Error("WRITE_READBACK_MISMATCH");
      return () => { Object.assign(format, before); };
    } else if (command.kind === "paragraph.set_spacing") {
      const format = paragraph!.Range.ParagraphFormat as WpsObject;
      const before = { LineUnitBefore: format.LineUnitBefore, LineUnitAfter: format.LineUnitAfter, LineSpacingRule: format.LineSpacingRule, LineSpacing: format.LineSpacing, PageBreakBefore: format.PageBreakBefore, OutlineLevel: format.OutlineLevel, SnapToGrid: format.SnapToGrid };
      const beforeLines = Number(args.space_before_lines); const afterLines = Number(args.space_after_lines); const outlineLevel = Number(args.outline_level ?? 10);
      format.LineSpacingRule = 4; format.LineSpacing = args.line_spacing_pt; format.LineUnitBefore = beforeLines; format.LineUnitAfter = afterLines; format.PageBreakBefore = args.page_break_before ? 1 : 0; format.OutlineLevel = outlineLevel; format.SnapToGrid = false;
      if (!WpsUnitConverter.close(Number(format.LineUnitBefore), beforeLines) || !WpsUnitConverter.close(Number(format.LineUnitAfter), afterLines) || Number(format.LineSpacingRule) !== 4 || !WpsUnitConverter.close(Number(format.LineSpacing), Number(args.line_spacing_pt)) || Boolean(format.PageBreakBefore) !== Boolean(args.page_break_before) || Number(format.OutlineLevel) !== outlineLevel || Boolean(format.SnapToGrid)) throw new Error("WRITE_READBACK_MISMATCH");
      return () => { Object.assign(format, before); };
    } else if (command.kind === "section.set_page_setup") {
      // WPS exposes PageSetup on Range and Section.  Range.PageSetup targets the
      // section that contains the command anchor; Document.PageSetup would instead
      // risk applying the first section's settings to a multi-section document.
      const setup = paragraph!.Range.PageSetup as WpsObject;
      const before = { PageWidth: setup.PageWidth, PageHeight: setup.PageHeight, TopMargin: setup.TopMargin, BottomMargin: setup.BottomMargin, LeftMargin: setup.LeftMargin, RightMargin: setup.RightMargin, LinesPage: setup.LinesPage, CharsLine: setup.CharsLine, LayoutMode: setup.LayoutMode, ShowGrid: setup.ShowGrid };
      const mode = (args.grid_mode ?? this.gridMode) as GridMode;
      if (mode === "strict_lines_and_chars") new GridReadbackValidator().assertStrictSupported();
      setup.PageWidth = WpsUnitConverter.centimetersToPoints(Number(args.page_width_cm)); setup.PageHeight = WpsUnitConverter.centimetersToPoints(Number(args.page_height_cm));
      setup.TopMargin = WpsUnitConverter.centimetersToPoints(Number(args.margin_top_cm)); setup.BottomMargin = WpsUnitConverter.centimetersToPoints(Number(args.margin_bottom_cm));
      setup.LeftMargin = WpsUnitConverter.centimetersToPoints(Number(args.margin_left_cm)); setup.RightMargin = WpsUnitConverter.centimetersToPoints(Number(args.margin_right_cm));
      // line_only (the formal default) deliberately does not write LinesPage
      // or CharsLine.  In WPS either setting can reactivate a character grid;
      // fixed 28 pt paragraph spacing is the verifiable 22-line strategy.
      setup.LayoutMode = 0; setup.ShowGrid = false;
      if (!WpsUnitConverter.close(setup.PageWidth, WpsUnitConverter.centimetersToPoints(Number(args.page_width_cm))) || !WpsUnitConverter.close(setup.PageHeight, WpsUnitConverter.centimetersToPoints(Number(args.page_height_cm))) || !WpsUnitConverter.close(setup.TopMargin, WpsUnitConverter.centimetersToPoints(Number(args.margin_top_cm))) || !WpsUnitConverter.close(setup.BottomMargin, WpsUnitConverter.centimetersToPoints(Number(args.margin_bottom_cm))) || !WpsUnitConverter.close(setup.LeftMargin, WpsUnitConverter.centimetersToPoints(Number(args.margin_left_cm))) || !WpsUnitConverter.close(setup.RightMargin, WpsUnitConverter.centimetersToPoints(Number(args.margin_right_cm)))) throw new Error("WRITE_READBACK_MISMATCH");
      return () => { Object.assign(setup, before); };
    } else throw new Error("COMMAND_NOT_ALLOWED");
  }
  private validateGridReadback(paragraph: WpsObject, args: Record<string, unknown>): void {
    const range = paragraph.Range as WpsObject;
    const setup = range.PageSetup as WpsObject;
    const format = range.ParagraphFormat as WpsObject;
    const font = range.Font as WpsObject;
    const mode = (args.grid_mode ?? this.gridMode) as GridMode;
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
