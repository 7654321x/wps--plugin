import {
  FORMATTING_COMMAND_SET_VERSION,
  assertCommandRequest,
  assertFormattingCommandSet,
  type Capability,
  type CommandRequest,
  type CommandTarget,
  type FormattingCommand,
  type FormattingCommandSet,
  type RecognitionParagraph,
} from "../../contracts/src/index.js";
import type { CommandServiceClient } from "../../command-service-client/src/index.js";

export interface LocalFormatProfile {
  id: string;
  version: string;
  page_setup: {
    page_width_cm: number;
    page_height_cm: number;
    margin_top_cm: number;
    margin_bottom_cm: number;
    margin_left_cm: number;
    margin_right_cm: number;
    lines_per_page: number;
    chars_per_line: number;
    grid_alignment: "文字对齐字符网络";
    grid_mode: "natural" | "line_only" | "strict_lines_and_chars";
    normal_east_asia_font_name: string;
    normal_latin_font_name: string;
    normal_font_size_pt: number;
  };
  styles: Record<string, LocalParagraphStyle>;
}

export interface LocalParagraphStyle {
  east_asia_font_name: string;
  latin_font_name: string;
  font_size_pt: number;
  bold: boolean;
  alignment: "left" | "center" | "right" | "justify" | "distributed";
  first_line_indent_chars: number;
  left_indent_chars: number;
  right_indent_chars: number;
  space_before_lines: number;
  space_after_lines: number;
  line_spacing_rule: "exactly";
  line_spacing_pt: number;
  page_break_before: boolean;
  outline_level: number;
}

const CAPABILITY_BY_COMMAND: Record<FormattingCommand["kind"], Capability> = {
  "paragraph.set_font": "paragraph.font",
  "paragraph.set_alignment": "paragraph.alignment",
  "paragraph.set_indent": "paragraph.indent",
  "paragraph.set_spacing": "paragraph.spacing",
  "section.set_page_setup": "section.page_setup",
};
const STYLE_ROLE_ALIASES: Record<string, string> = {
  title_continuation: "main_title",
  addressing: "recipient",
};

function target(paragraph: RecognitionParagraph): CommandTarget {
  return {
    target_id: paragraph.target_id,
    source_paragraph_index: paragraph.source_paragraph_index,
    host_paragraph_index: paragraph.host_paragraph_index,
    host_raw_start_utf16: paragraph.host_raw_start_utf16,
    host_raw_end_utf16: paragraph.host_raw_end_utf16,
    host_raw_text_sha256: paragraph.host_raw_text_sha256,
    text_sha256: paragraph.text_sha256,
    text_length: paragraph.text_length,
    occurrence_index: paragraph.occurrence_index,
  };
}

function command<K extends FormattingCommand["kind"]>(
  number: number,
  kind: K,
  commandTarget: CommandTarget,
  args: Extract<FormattingCommand, { kind: K }>["arguments"],
): Extract<FormattingCommand, { kind: K }> {
  return {
    command_id: `cmd-${String(number).padStart(6, "0")}`,
    kind,
    target: commandTarget,
    arguments: args,
    required_capability: CAPABILITY_BY_COMMAND[kind],
    on_unsupported: "skip",
  } as Extract<FormattingCommand, { kind: K }>;
}

function paragraphCommands(start: number, paragraph: RecognitionParagraph, style: LocalParagraphStyle): FormattingCommand[] {
  const commandTarget = target(paragraph);
  return [
    command(start, "paragraph.set_font", commandTarget, {
      east_asia_font_name: style.east_asia_font_name,
      latin_font_name: style.latin_font_name,
      font_size_pt: style.font_size_pt,
      bold: style.bold,
    }),
    command(start + 1, "paragraph.set_alignment", commandTarget, { alignment: style.alignment }),
    command(start + 2, "paragraph.set_indent", commandTarget, {
      first_line_indent_chars: style.first_line_indent_chars,
      left_indent_chars: style.left_indent_chars,
      right_indent_chars: style.right_indent_chars,
    }),
    command(start + 3, "paragraph.set_spacing", commandTarget, {
      space_before_lines: style.space_before_lines,
      space_after_lines: style.space_after_lines,
      line_spacing_rule: style.line_spacing_rule,
      line_spacing_pt: style.line_spacing_pt,
      page_break_before: style.page_break_before,
      outline_level: style.outline_level,
    }),
  ];
}

export class LocalFormatCommandGenerator implements CommandServiceClient {
  constructor(private readonly profile: LocalFormatProfile) {}

  async requestCommands(request: CommandRequest): Promise<FormattingCommandSet> {
    assertCommandRequest(request);
    const supported = new Set(request.client_capabilities.capabilities);
    const commands: FormattingCommand[] = [];
    const warnings: string[] = [];
    const first = request.recognition_result.paragraphs[0];
    if (first) {
      const page = this.profile.page_setup;
      commands.push(command(1, "section.set_page_setup", {
        ...target(first),
        target_id: `document:${request.recognition_result.document_id}`,
      }, {
        page_width_cm: page.page_width_cm,
        page_height_cm: page.page_height_cm,
        margin_top_cm: page.margin_top_cm,
        margin_bottom_cm: page.margin_bottom_cm,
        margin_left_cm: page.margin_left_cm,
        margin_right_cm: page.margin_right_cm,
        lines_per_page: page.lines_per_page,
        chars_per_line: page.chars_per_line,
        grid_alignment: page.grid_alignment,
        grid_mode: page.grid_mode,
      }));
    }
    for (const paragraph of request.recognition_result.paragraphs) {
      if (paragraph.formatting_disposition !== "apply") {
        warnings.push(`REVIEW_ONLY_TARGET_SKIPPED:${paragraph.target_id}`);
        continue;
      }
      const styleKey = STYLE_ROLE_ALIASES[paragraph.recognized_type] ?? paragraph.recognized_type;
      const style = this.profile.styles[styleKey];
      if (!style) {
        warnings.push(`STYLE_NOT_FOUND:${styleKey}`);
        continue;
      }
      commands.push(...paragraphCommands(commands.length + 1, paragraph, style));
    }
    const filtered = commands.filter((item) => {
      if (supported.has(item.required_capability)) return true;
      if (item.on_unsupported === "fail") throw new Error("CAPABILITY_REQUIRED");
      warnings.push(`CAPABILITY_SKIPPED:${item.command_id}:${item.required_capability}`);
      return false;
    });
    const result: FormattingCommandSet = {
      schema_version: FORMATTING_COMMAND_SET_VERSION,
      request_id: request.request_id,
      service_version: "local-format-engine/1.0",
      profile_id: this.profile.id,
      profile_version: this.profile.version,
      commands: filtered,
      warnings,
    };
    assertFormattingCommandSet(result, request.request_id);
    return result;
  }
}
