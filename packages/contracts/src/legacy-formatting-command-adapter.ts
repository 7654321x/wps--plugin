import {
  FORMATTING_COMMAND_SET_VERSION,
  type CommandKind,
  type CommandTarget,
  type FormattingCommand,
  type FormattingCommandSet,
} from "./index.js";

/**
 * The only compatibility boundary for FormattingCommandSet 1.0.  Production
 * validators and executors only receive the strict 1.1 discriminated union.
 */
export interface LegacyFormattingCommandSet {
  schema_version: "1.0";
  request_id: string;
  service_version: string;
  commands: Array<{
    command_id: string; kind: CommandKind; target: CommandTarget;
    arguments: Record<string, unknown>; required_capability: FormattingCommand["required_capability"];
    on_unsupported: "skip" | "fail";
  }>;
  warnings: string[];
}

export class LegacyFormattingCommandAdapter {
  adapt(commandSet: LegacyFormattingCommandSet, profileId = "default", profileVersion = "1.0", latinFontName = "Times New Roman"): FormattingCommandSet {
    const commands = commandSet.commands.map((command) => this.adaptCommand(command, latinFontName));
    return {
      schema_version: FORMATTING_COMMAND_SET_VERSION,
      request_id: commandSet.request_id,
      service_version: commandSet.service_version,
      profile_id: profileId,
      profile_version: profileVersion,
      commands,
      warnings: [...commandSet.warnings, "LEGACY_FORMATTING_COMMAND_ADAPTED"],
    };
  }

  private adaptCommand(command: LegacyFormattingCommandSet["commands"][number], latinFontName: string): FormattingCommand {
    const target = command.target;
    if (command.kind === "paragraph.set_font") {
      if (typeof command.arguments.font_family !== "string" || typeof command.arguments.font_size_pt !== "number" || typeof command.arguments.bold !== "boolean") throw new Error("LEGACY_COMMAND_AMBIGUOUS");
      return { ...command, kind: "paragraph.set_font", required_capability: "paragraph.font", target, arguments: { east_asia_font_name: command.arguments.font_family, latin_font_name: latinFontName, font_size_pt: command.arguments.font_size_pt, bold: command.arguments.bold } };
    }
    if (command.kind === "paragraph.set_spacing") {
      const before = command.arguments.space_before_pt;
      const after = command.arguments.space_after_pt;
      const line = command.arguments.line_spacing_pt;
      if (typeof before !== "number" || typeof after !== "number" || typeof line !== "number" || line <= 0) throw new Error("LEGACY_COMMAND_AMBIGUOUS");
      return { ...command, kind: "paragraph.set_spacing", required_capability: "paragraph.spacing", target, arguments: { space_before_lines: before / line, space_after_lines: after / line, line_spacing_rule: "exactly", line_spacing_pt: line, page_break_before: false, outline_level: 10 } };
    }
    throw new Error("LEGACY_COMMAND_AMBIGUOUS");
  }
}
