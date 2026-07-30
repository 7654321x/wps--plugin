import {
  FORMATTING_COMMAND_SET_VERSION,
  type CommandTarget,
  type FormattingCommand,
  type FormattingCommandSet,
  type RecognitionParagraph,
  type RecognitionResult,
  type SetAlignmentCommandV11,
  type SetFontCommandV11,
  type SetIndentCommandV11,
  type SetPageSetupArguments,
  type SetPageSetupCommandV11,
  type SetSpacingCommandV11,
} from "../../contracts/src/index.js";

type ProfileStyle = {
  east_asia_font_name: string; latin_font_name: string; font_size_pt: number; bold: boolean;
  alignment: "left" | "center" | "right" | "justify" | "distributed";
  first_line_indent_chars: number; left_indent_chars: number; right_indent_chars: number;
  space_before_lines: number; space_after_lines: number; line_spacing_rule: "exactly";
  line_spacing_pt: number; page_break_before: boolean; outline_level: number;
};
export interface DevWriteTestProfile { page_setup: SetPageSetupArguments; styles: Record<string, ProfileStyle>; }

/** Test-only command-plan builder. It has no WPS API access or write path. */
export class DevWriteTestPlanBuilder {
  constructor(private readonly profile: DevWriteTestProfile) {}

  build(recognition: RecognitionResult, requestId: string): FormattingCommandSet {
    const commands: FormattingCommand[] = [];
    const first = recognition.paragraphs[0];
    if (first) commands.push(this.pageCommand(commands.length + 1, first));
    for (const paragraph of recognition.paragraphs) {
      const style = this.styleForRole(paragraph.recognized_type);
      if (!style) continue;
      const target = this.target(paragraph);
      commands.push(this.fontCommand(commands.length + 1, target, style));
      commands.push(this.alignmentCommand(commands.length + 1, target, style));
      commands.push(this.indentCommand(commands.length + 1, target, style));
      commands.push(this.spacingCommand(commands.length + 1, target, style));
    }
    return { schema_version: FORMATTING_COMMAND_SET_VERSION, request_id: requestId, service_version: "dev-write-test-plan", profile_id: "default", profile_version: "1.0", commands, warnings: ["DEV_WRITE_TEST_PLAN"] };
  }

  styleForRole(role: string): ProfileStyle | undefined {
    if (!role.startsWith("body:")) return this.profile.styles[role];
    const body = this.profile.styles.body;
    return body ? { ...body, alignment: role.slice(5) as ProfileStyle["alignment"], first_line_indent_chars: 0, left_indent_chars: 0, right_indent_chars: 0 } : undefined;
  }
  private target(item: RecognitionParagraph): CommandTarget {
    return { target_id: item.target_id, source_paragraph_index: item.source_paragraph_index, text_sha256: item.text_sha256, text_length: item.text_length, occurrence_index: item.occurrence_index };
  }
  private pageCommand(number: number, item: RecognitionParagraph): SetPageSetupCommandV11 {
    return { command_id: this.id(number), kind: "section.set_page_setup", target: this.target(item), arguments: { ...this.profile.page_setup, grid_mode: "line_only" }, required_capability: "section.page_setup", on_unsupported: "fail" };
  }
  private fontCommand(number: number, target: CommandTarget, style: ProfileStyle): SetFontCommandV11 {
    return { command_id: this.id(number), kind: "paragraph.set_font", target, arguments: { east_asia_font_name: style.east_asia_font_name, latin_font_name: style.latin_font_name, font_size_pt: style.font_size_pt, bold: style.bold }, required_capability: "paragraph.font", on_unsupported: "fail" };
  }
  private alignmentCommand(number: number, target: CommandTarget, style: ProfileStyle): SetAlignmentCommandV11 {
    return { command_id: this.id(number), kind: "paragraph.set_alignment", target, arguments: { alignment: style.alignment }, required_capability: "paragraph.alignment", on_unsupported: "fail" };
  }
  private indentCommand(number: number, target: CommandTarget, style: ProfileStyle): SetIndentCommandV11 {
    return { command_id: this.id(number), kind: "paragraph.set_indent", target, arguments: { first_line_indent_chars: style.first_line_indent_chars, left_indent_chars: style.left_indent_chars, right_indent_chars: style.right_indent_chars }, required_capability: "paragraph.indent", on_unsupported: "fail" };
  }
  private spacingCommand(number: number, target: CommandTarget, style: ProfileStyle): SetSpacingCommandV11 {
    return { command_id: this.id(number), kind: "paragraph.set_spacing", target, arguments: { space_before_lines: style.space_before_lines, space_after_lines: style.space_after_lines, line_spacing_rule: style.line_spacing_rule, line_spacing_pt: style.line_spacing_pt, page_break_before: style.page_break_before, outline_level: style.outline_level }, required_capability: "paragraph.spacing", on_unsupported: "fail" };
  }
  private id(number: number): string { return "cmd-" + String(number).padStart(6, "0"); }
}
