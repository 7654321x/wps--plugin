export const PROTOCOL_VERSION = "1.0" as const;
export const FORMATTING_COMMAND_SET_V11 = "1.1" as const;

export type Alignment = "left" | "center" | "right" | "justify" | "distributed";
export type CommandKind =
  | "paragraph.set_font"
  | "paragraph.set_alignment"
  | "paragraph.set_indent"
  | "paragraph.set_spacing"
  | "section.set_page_setup";
export type Capability =
  | "paragraph.font"
  | "paragraph.alignment"
  | "paragraph.indent"
  | "paragraph.spacing"
  | "section.page_setup"
  | "transaction.undo";
export type ReviewLevel = "confirmed" | "info" | "review" | "critical_review";

export interface Target {
  target_id: string;
  source_paragraph_index: number;
  text_sha256: string;
}
export interface RecognitionParagraph extends Target {
  recognized_type: string; section_kind: string; text_length: number; occurrence_index: number;
  confidence: number; review_level: ReviewLevel; needs_review: boolean;
}
export interface RecognitionResult {
  schema_version: typeof PROTOCOL_VERSION; recognition_engine_version: string; document_id: string;
  document_revision: string; source_sha256: string;
  document_mode: "unknown" | "normal" | "report" | "notice" | "plan" | "meeting_minutes";
  document_mode_confidence: number; paragraphs: RecognitionParagraph[];
  review_items?: Array<{ target_id: string; level: "review" | "critical_review"; confidence: number }>;
}
export interface ClientCapabilities { schema_version: typeof PROTOCOL_VERSION; capabilities: Capability[]; }
export interface CommandRequest {
  schema_version: typeof PROTOCOL_VERSION; request_id: string; recognition_result: RecognitionResult;
  profile_id: string; profile_version: string; client_capabilities: ClientCapabilities;
  product_version: string; authorization_scope: "classified-offline" | "standard-online";
}
export interface FormattingCommand {
  command_id: string; kind: CommandKind; target: Target; arguments: Record<string, unknown>;
  required_capability: Exclude<Capability, "transaction.undo">; on_unsupported: "skip" | "fail";
}
export interface FormattingCommandSet {
  schema_version: typeof PROTOCOL_VERSION; request_id: string; service_version: string;
  commands: FormattingCommand[]; warnings: string[];
}
export interface ExecutionResult {
  schema_version: typeof PROTOCOL_VERSION; transaction_id: string; executed_command_ids: string[];
  skipped_command_ids: string[]; failed_command_id: string | null; warnings: string[];
  rolled_back: boolean; document_revision: string;
}
export const ALLOWED_COMMANDS: ReadonlySet<CommandKind> = new Set([
  "paragraph.set_font", "paragraph.set_alignment", "paragraph.set_indent",
  "paragraph.set_spacing", "section.set_page_setup",
]);
const FORBIDDEN_FIELDS = new Set([
  "text", "raw_text", "original_text", "paragraph_text", "document_content",
  "file_content", "file_base64", "local_path", "absolute_path", "javascript",
  "python_code", "script", "code",
]);
const SHA256 = /^[a-f0-9]{64}$/;

export function assertNoSensitiveFields(value: unknown): void {
  if (Array.isArray(value)) value.forEach(assertNoSensitiveFields);
  else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (FORBIDDEN_FIELDS.has(key)) throw new Error("SENSITIVE_FIELD_REJECTED:" + key);
      assertNoSensitiveFields(nested);
    }
  }
}
export function assertCommandRequest(request: CommandRequest): void {
  assertNoSensitiveFields(request);
  if (request.schema_version !== PROTOCOL_VERSION) throw new Error("UNSUPPORTED_SCHEMA_VERSION");
  if (!/^[A-Za-z0-9-]{16,64}$/.test(request.request_id)) throw new Error("INVALID_REQUEST_ID");
  if (!SHA256.test(request.recognition_result.source_sha256)) throw new Error("INVALID_SOURCE_SHA256");
  request.recognition_result.paragraphs.forEach((paragraph) => {
    if (!SHA256.test(paragraph.text_sha256)) throw new Error("INVALID_TEXT_SHA256");
    if (paragraph.text_length < 0 || paragraph.occurrence_index < 0) throw new Error("INVALID_ANCHOR");
  });
}
export function assertFormattingCommandSet(result: FormattingCommandSet, expectedRequestId: string): void {
  if (result.schema_version !== PROTOCOL_VERSION) throw new Error("UNSUPPORTED_SCHEMA_VERSION");
  if (result.request_id !== expectedRequestId) throw new Error("REQUEST_ID_MISMATCH");
  for (const command of result.commands) {
    if (!ALLOWED_COMMANDS.has(command.kind)) throw new Error("UNKNOWN_COMMAND");
    if (!SHA256.test(command.target.text_sha256)) throw new Error("INVALID_TARGET_HASH");
    validateCommandArguments(command);
  }
}
function numeric(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function validateCommandArguments(command: FormattingCommand): void {
  const args = command.arguments;
  if (command.kind === "paragraph.set_font") {
    const east = args.east_asia_font_name ?? args.font_family;
    const latin = args.latin_font_name ?? args.font_family;
    if (typeof east !== "string" || typeof latin !== "string" || !numeric(args.font_size_pt, 5, 72) || typeof args.bold !== "boolean") throw new Error("INVALID_COMMAND_ARGUMENTS");
  } else if (command.kind === "paragraph.set_alignment") {
    if (!["left", "center", "right", "justify", "distributed"].includes(String(args.alignment))) throw new Error("INVALID_COMMAND_ARGUMENTS");
  } else if (command.kind === "paragraph.set_indent") {
    for (const key of ["first_line_indent_chars", "left_indent_chars", "right_indent_chars"]) if (!numeric(args[key], 0, 10)) throw new Error("INVALID_COMMAND_ARGUMENTS");
  } else if (command.kind === "paragraph.set_spacing") {
    const before = args.space_before_lines;
    const after = args.space_after_lines;
    if (!numeric(args.line_spacing_pt, 8, 100) || !numeric(before, 0, 10) || !numeric(after, 0, 10) || (args.line_spacing_rule !== undefined && args.line_spacing_rule !== "exactly") || (args.page_break_before !== undefined && typeof args.page_break_before !== "boolean") || (args.outline_level !== undefined && !numeric(args.outline_level, 1, 10))) throw new Error("INVALID_COMMAND_ARGUMENTS");
  } else {
    for (const key of ["page_width_cm", "page_height_cm"]) if (!numeric(args[key], 10, 60)) throw new Error("INVALID_COMMAND_ARGUMENTS");
    for (const key of ["margin_top_cm", "margin_bottom_cm", "margin_left_cm", "margin_right_cm"]) if (!numeric(args[key], 0, 10)) throw new Error("INVALID_COMMAND_ARGUMENTS");
    if (!numeric(args.lines_per_page, 1, 100) || !numeric(args.chars_per_line, 1, 200) || args.grid_alignment !== "文字对齐字符网络" || !["natural", "line_only", "strict_lines_and_chars"].includes(String(args.grid_mode))) throw new Error("INVALID_COMMAND_ARGUMENTS");
  }
}
