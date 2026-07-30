import { PROTOCOL_VERSION, type FormattingCommand, type FormattingCommandSet, type RecognitionResult } from "../../contracts/src/index.js";

type ProfileStyle = {
  east_asia_font_name: string; latin_font_name: string; font_size_pt: number; bold: boolean;
  alignment: "left" | "center" | "right" | "justify" | "distributed";
  first_line_indent_chars: number; left_indent_chars: number; right_indent_chars: number;
  space_before_lines: number; space_after_lines: number; line_spacing_rule: "exactly";
  line_spacing_pt: number; page_break_before: boolean; outline_level: number;
};
export interface DevWriteTestProfile { page_setup: Record<string, unknown>; styles: Record<string, ProfileStyle>; }

/**
 * Builds only protocol commands for the generated fixture.  It contains no
 * WPS API access; the normal WpsApiDocumentExecutor remains the single writer.
 */
export class DevWriteTestPlanBuilder {
  constructor(private readonly profile: DevWriteTestProfile) {}

  build(recognition: RecognitionResult, requestId: string): FormattingCommandSet {
    const commands: FormattingCommand[] = [];
    const first = recognition.paragraphs[0];
    if (first) {
      const page = this.profile.page_setup;
      commands.push(this.command(commands.length + 1, "section.set_page_setup", first, {
        page_width_cm: page.page_width_cm, page_height_cm: page.page_height_cm, margin_top_cm: page.margin_top_cm, margin_bottom_cm: page.margin_bottom_cm,
        margin_left_cm: page.margin_left_cm, margin_right_cm: page.margin_right_cm, lines_per_page: page.lines_per_page, chars_per_line: page.chars_per_line,
        grid_alignment: page.grid_alignment, grid_mode: "line_only",
      }));
    }
    for (const paragraph of recognition.paragraphs) {
      const style = this.styleForRole(paragraph.recognized_type);
      if (!style) continue;
      commands.push(this.command(commands.length + 1, "paragraph.set_font", paragraph, { east_asia_font_name: style.east_asia_font_name, latin_font_name: style.latin_font_name, font_size_pt: style.font_size_pt, bold: style.bold }));
      commands.push(this.command(commands.length + 1, "paragraph.set_alignment", paragraph, { alignment: style.alignment }));
      commands.push(this.command(commands.length + 1, "paragraph.set_indent", paragraph, { first_line_indent_chars: style.first_line_indent_chars, left_indent_chars: style.left_indent_chars, right_indent_chars: style.right_indent_chars }));
      commands.push(this.command(commands.length + 1, "paragraph.set_spacing", paragraph, { space_before_lines: style.space_before_lines, space_after_lines: style.space_after_lines, line_spacing_rule: style.line_spacing_rule, line_spacing_pt: style.line_spacing_pt, page_break_before: style.page_break_before, outline_level: style.outline_level }));
    }
    return { schema_version: PROTOCOL_VERSION, request_id: requestId, service_version: "dev-write-test-plan", commands, warnings: ["DEV_WRITE_TEST_PLAN"] };
  }

  styleForRole(role: string): ProfileStyle | undefined {
    if (!role.startsWith("body:")) return this.profile.styles[role];
    const body = this.profile.styles.body;
    return body ? { ...body, alignment: role.slice(5) as ProfileStyle["alignment"], first_line_indent_chars: 0, left_indent_chars: 0, right_indent_chars: 0 } : undefined;
  }

  private command(number: number, kind: FormattingCommand["kind"], target: RecognitionResult["paragraphs"][number], arguments_: Record<string, unknown>): FormattingCommand {
    const capability = kind === "section.set_page_setup" ? "section.page_setup" : kind === "paragraph.set_font" ? "paragraph.font" : kind === "paragraph.set_alignment" ? "paragraph.alignment" : kind === "paragraph.set_indent" ? "paragraph.indent" : "paragraph.spacing";
    return { command_id: "cmd-" + String(number).padStart(6, "0"), kind, target: { target_id: target.target_id, source_paragraph_index: target.source_paragraph_index, text_sha256: target.text_sha256 }, arguments: arguments_, required_capability: capability, on_unsupported: "fail" };
  }
}
