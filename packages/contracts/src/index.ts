/** Contract versions are independent.  Do not merge these into a global version. */
export const RECOGNITION_RESULT_VERSION = "1.0" as const;
export const COMMAND_REQUEST_VERSION = "1.0" as const;
export const FORMATTING_COMMAND_SET_VERSION = "1.1" as const;
export const CLIENT_CAPABILITIES_VERSION = "1.0" as const;
export const EXECUTION_RESULT_VERSION = "1.0" as const;

export type Alignment = "left" | "center" | "right" | "justify" | "distributed";
export type GridMode = "natural" | "line_only" | "strict_lines_and_chars";
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
export interface CommandTarget extends Target {
  text_length: number;
  occurrence_index: number;
}
export interface RecognitionParagraph extends Target {
  recognized_type: string; section_kind: string; text_length: number; occurrence_index: number;
  confidence: number; review_level: ReviewLevel; needs_review: boolean;
}
export interface RecognitionResult {
  schema_version: typeof RECOGNITION_RESULT_VERSION; recognition_engine_version: string; document_id: string;
  document_revision: string; source_sha256: string;
  document_mode: "unknown" | "normal" | "report" | "notice" | "plan" | "meeting_minutes";
  document_mode_confidence: number; paragraphs: RecognitionParagraph[];
  review_items?: Array<{ target_id: string; level: "review" | "critical_review"; confidence: number }>;
}
export interface ClientCapabilities { schema_version: typeof CLIENT_CAPABILITIES_VERSION; capabilities: Capability[]; }
export interface CommandRequest {
  schema_version: typeof COMMAND_REQUEST_VERSION; request_id: string; recognition_result: RecognitionResult;
  profile_id: string; profile_version: string; client_capabilities: ClientCapabilities;
  product_version: string; authorization_scope: "classified-offline" | "standard-online";
}
export interface SetFontArguments {
  east_asia_font_name: string; latin_font_name: string; font_size_pt: number; bold: boolean;
}
export interface SetAlignmentArguments { alignment: Alignment; }
export interface SetIndentArguments {
  first_line_indent_chars: number; left_indent_chars: number; right_indent_chars: number;
}
export interface SetSpacingArguments {
  space_before_lines: number; space_after_lines: number; line_spacing_rule: "exactly";
  line_spacing_pt: number; page_break_before: boolean; outline_level: number;
}
export interface SetPageSetupArguments {
  page_width_cm: number; page_height_cm: number;
  margin_top_cm: number; margin_bottom_cm: number; margin_left_cm: number; margin_right_cm: number;
  lines_per_page: number; chars_per_line: number; grid_alignment: "文字对齐字符网络"; grid_mode: GridMode;
}
interface CommandBase<K extends CommandKind, A, C extends Capability> {
  command_id: string; kind: K; target: CommandTarget; arguments: A;
  required_capability: C; on_unsupported: "skip" | "fail";
}
export type SetFontCommandV11 = CommandBase<"paragraph.set_font", SetFontArguments, "paragraph.font">;
export type SetAlignmentCommandV11 = CommandBase<"paragraph.set_alignment", SetAlignmentArguments, "paragraph.alignment">;
export type SetIndentCommandV11 = CommandBase<"paragraph.set_indent", SetIndentArguments, "paragraph.indent">;
export type SetSpacingCommandV11 = CommandBase<"paragraph.set_spacing", SetSpacingArguments, "paragraph.spacing">;
export type SetPageSetupCommandV11 = CommandBase<"section.set_page_setup", SetPageSetupArguments, "section.page_setup">;
export type FormattingCommand = SetFontCommandV11 | SetAlignmentCommandV11 | SetIndentCommandV11 | SetSpacingCommandV11 | SetPageSetupCommandV11;
export interface FormattingCommandSet {
  schema_version: typeof FORMATTING_COMMAND_SET_VERSION; request_id: string; service_version: string;
  profile_id: string; profile_version: string; commands: FormattingCommand[]; warnings: string[];
}
export interface ExecutionResult {
  schema_version: typeof EXECUTION_RESULT_VERSION; transaction_id: string; executed_command_ids: string[];
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
  if (request.schema_version !== COMMAND_REQUEST_VERSION) throw new Error("UNSUPPORTED_COMMAND_REQUEST_VERSION");
  if (request.recognition_result.schema_version !== RECOGNITION_RESULT_VERSION) throw new Error("UNSUPPORTED_RECOGNITION_RESULT_VERSION");
  if (request.client_capabilities.schema_version !== CLIENT_CAPABILITIES_VERSION) throw new Error("UNSUPPORTED_CLIENT_CAPABILITIES_VERSION");
  if (!/^[A-Za-z0-9-]{16,64}$/.test(request.request_id)) throw new Error("INVALID_REQUEST_ID");
  if (!SHA256.test(request.recognition_result.source_sha256)) throw new Error("INVALID_SOURCE_SHA256");
  request.recognition_result.paragraphs.forEach((paragraph) => {
    if (!SHA256.test(paragraph.text_sha256)) throw new Error("INVALID_TEXT_SHA256");
    if (paragraph.text_length < 0 || paragraph.occurrence_index < 0) throw new Error("INVALID_ANCHOR");
  });
}
export function assertFormattingCommandSet(result: FormattingCommandSet, expectedRequestId: string): void {
  if (result.schema_version !== FORMATTING_COMMAND_SET_VERSION) throw new Error("UNSUPPORTED_FORMATTING_COMMAND_SET_VERSION");
  if (result.request_id !== expectedRequestId) throw new Error("REQUEST_ID_MISMATCH");
  for (const command of result.commands) {
    if (!ALLOWED_COMMANDS.has(command.kind)) throw new Error("UNKNOWN_COMMAND");
    if (!SHA256.test(command.target.text_sha256) || command.target.text_length < 0 || command.target.occurrence_index < 0) throw new Error("INVALID_TARGET_HASH");
    validateCommandArguments(command);
  }
}
function numeric(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function validateCommandArguments(command: FormattingCommand): void {
  switch (command.kind) {
    case "paragraph.set_font":
      if (!command.arguments.east_asia_font_name || !command.arguments.latin_font_name || !numeric(command.arguments.font_size_pt, 5, 72) || typeof command.arguments.bold !== "boolean") throw new Error("INVALID_COMMAND_ARGUMENTS");
      return;
    case "paragraph.set_alignment":
      if (!["left", "center", "right", "justify", "distributed"].includes(command.arguments.alignment)) throw new Error("INVALID_COMMAND_ARGUMENTS");
      return;
    case "paragraph.set_indent":
      if (![command.arguments.first_line_indent_chars, command.arguments.left_indent_chars, command.arguments.right_indent_chars].every((value) => numeric(value, -10, 10))) throw new Error("INVALID_COMMAND_ARGUMENTS");
      return;
    case "paragraph.set_spacing":
      if (!numeric(command.arguments.line_spacing_pt, 8, 100) || !numeric(command.arguments.space_before_lines, 0, 10) || !numeric(command.arguments.space_after_lines, 0, 10) || command.arguments.line_spacing_rule !== "exactly" || typeof command.arguments.page_break_before !== "boolean" || !numeric(command.arguments.outline_level, 1, 10)) throw new Error("INVALID_COMMAND_ARGUMENTS");
      return;
    case "section.set_page_setup":
      if (![command.arguments.page_width_cm, command.arguments.page_height_cm].every((value) => numeric(value, 10, 60)) || ![command.arguments.margin_top_cm, command.arguments.margin_bottom_cm, command.arguments.margin_left_cm, command.arguments.margin_right_cm].every((value) => numeric(value, 0, 10)) || !numeric(command.arguments.lines_per_page, 1, 100) || !numeric(command.arguments.chars_per_line, 1, 200) || command.arguments.grid_alignment !== "文字对齐字符网络" || !["natural", "line_only", "strict_lines_and_chars"].includes(command.arguments.grid_mode)) throw new Error("INVALID_COMMAND_ARGUMENTS");
  }
}
