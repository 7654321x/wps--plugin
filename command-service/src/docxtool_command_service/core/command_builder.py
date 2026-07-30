"""Pure command generator. It receives only redacted protocol data."""

from .capability_matcher import match_capabilities
from .command_policy import CAPABILITY_BY_COMMAND
from .profile_registry import resolve_profile
from .validation import CommandServiceError, validate_command_request, validate_command_set
from .version import PROTOCOL_VERSION, SERVICE_VERSION


def _command(command_number, kind, target, arguments):
    return {
        "command_id": "cmd-%06d" % command_number,
        "kind": kind,
        "target": target,
        "arguments": arguments,
        "required_capability": CAPABILITY_BY_COMMAND[kind],
        "on_unsupported": "skip",
    }


def _paragraph_commands(command_number, paragraph, style):
    target = {
        "target_id": paragraph["target_id"],
        "source_paragraph_index": paragraph["source_paragraph_index"],
        "text_sha256": paragraph["text_sha256"],
    }
    commands = []
    commands.append(_command(command_number + len(commands), "paragraph.set_font", target, {
        "east_asia_font_name": style["east_asia_font_name"],
        "latin_font_name": style["latin_font_name"],
        "font_size_pt": style["font_size_pt"],
        "bold": style["bold"],
    }))
    commands.append(_command(command_number + len(commands), "paragraph.set_alignment", target, {
        "alignment": style["alignment"],
    }))
    commands.append(_command(command_number + len(commands), "paragraph.set_indent", target, {
        "first_line_indent_chars": style["first_line_indent_chars"],
        "left_indent_chars": style["left_indent_chars"],
        "right_indent_chars": style["right_indent_chars"],
    }))
    commands.append(_command(command_number + len(commands), "paragraph.set_spacing", target, {
        "space_before_lines": style["space_before_lines"],
        "space_after_lines": style["space_after_lines"],
        "line_spacing_rule": style["line_spacing_rule"],
        "line_spacing_pt": style["line_spacing_pt"],
        "page_break_before": style["page_break_before"],
        "outline_level": style["outline_level"],
    }))
    return commands


def build_formatting_commands(request):
    """Build a FormattingCommandSet without HTTP, DOCX, WPS or wheel imports."""
    validate_command_request(request)
    profile = resolve_profile(request["profile_id"], request["profile_version"])
    recognition = request["recognition_result"]
    commands = []
    paragraphs = recognition["paragraphs"]
    if paragraphs:
        page_target = {
            "target_id": "document:%s" % recognition["document_id"],
            "source_paragraph_index": paragraphs[0]["source_paragraph_index"],
            "text_sha256": recognition["source_sha256"],
        }
        page = profile["page_setup"]
        commands.append(_command(1, "section.set_page_setup", page_target, {
            key: page[key] for key in (
                "page_width_cm", "page_height_cm", "margin_top_cm", "margin_bottom_cm",
                "margin_left_cm", "margin_right_cm", "lines_per_page", "chars_per_line", "grid_alignment", "grid_mode",
            )
        }))
    for paragraph in paragraphs:
        style = profile["styles"].get(paragraph["recognized_type"])
        if style:
            commands.extend(_paragraph_commands(len(commands) + 1, paragraph, style))
    try:
        commands, warnings = match_capabilities(
            commands, request["client_capabilities"]["capabilities"],
        )
    except ValueError as exc:
        raise CommandServiceError("CAPABILITY_REQUIRED", str(exc))
    result = {
        "schema_version": PROTOCOL_VERSION,
        "request_id": request["request_id"],
        "service_version": SERVICE_VERSION,
        "commands": commands,
        "warnings": warnings,
    }
    validate_command_set(result)
    return result
