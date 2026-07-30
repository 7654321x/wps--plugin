import type { FormattingCommandSet } from "./index.js";

/** Converts only unambiguous 1.0 fields before strict 1.1 validation. */
export class LegacyFormattingCommandAdapter {
  adapt(commandSet: FormattingCommandSet, latinFontName = "Times New Roman"): FormattingCommandSet {
    const commands = commandSet.commands.map((command) => {
      const args = command.arguments;
      if (command.kind === "paragraph.set_font" && typeof args.font_family === "string") return { ...command, arguments: { east_asia_font_name: args.font_family, latin_font_name: latinFontName, font_size_pt: args.font_size_pt, bold: args.bold } };
      if (command.kind === "paragraph.set_spacing" && typeof args.space_before_pt === "number" && typeof args.space_after_pt === "number" && typeof args.line_spacing_pt === "number") return { ...command, arguments: { space_before_lines: args.space_before_pt / args.line_spacing_pt, space_after_lines: args.space_after_pt / args.line_spacing_pt, line_spacing_rule: "exactly", line_spacing_pt: args.line_spacing_pt, page_break_before: false, outline_level: 10 } };
      return command;
    });
    return { ...commandSet, commands, warnings: [...commandSet.warnings, "LEGACY_FORMATTING_COMMAND_ADAPTED"] };
  }
}
