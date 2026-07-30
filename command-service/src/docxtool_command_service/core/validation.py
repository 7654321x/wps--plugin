"""Strict protocol validation aligned with the frozen JSON Schemas.

The service intentionally uses explicit checks instead of accepting arbitrary
objects.  Keeping this module dependency-free preserves the pure-core build.
"""

import re

from .command_policy import (
    ALIGNMENTS,
    ALLOWED_COMMANDS,
    CAPABILITY_BY_COMMAND,
    FORBIDDEN_FIELD_NAMES,
)
from .version import PROTOCOL_VERSION


class CommandServiceError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9-]{16,64}$")
_TARGET_ID = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")
_RECOGNIZED_TYPES = frozenset((
    "main_title", "title_continuation", "dispatch_number", "recipient", "body",
    "heading1", "heading2", "heading3", "heading4", "key_value", "meeting_meta",
    "signature_org", "signature_date", "source_note", "embedded_document_title",
    "attachment_note", "attachment_title", "addressing", "date_line", "author_line",
    "role_name", "title2", "glossary_title", "glossary_item", "attachment_note_item",
    "attachment_page_mark", "attachment_body", "heading1_report", "list",
    "list_item", "quote", "annotation", "closing", "number", "letter",
    "page_number", "superscript", "caption", "unknown",
))
_SECTION_KINDS = frozenset((
    "header", "dispatch_meta", "recipient", "body", "meeting_meta", "signature",
    "source_note", "embedded_document", "attachment_note", "attachment_body",
))


def _fail(code, message):
    raise CommandServiceError(code, message)


def _require_object(value, name):
    if not isinstance(value, dict):
        _fail("INVALID_SCHEMA", "%s must be an object" % name)
    return value


def _reject_forbidden(value):
    if isinstance(value, dict):
        for key, nested in value.items():
            if key in FORBIDDEN_FIELD_NAMES:
                _fail("SENSITIVE_FIELD_REJECTED", "forbidden field: %s" % key)
            _reject_forbidden(nested)
    elif isinstance(value, list):
        for nested in value:
            _reject_forbidden(nested)


def _number(value, name, minimum, maximum):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not minimum <= value <= maximum:
        _fail("INVALID_PARAMETER", "%s is outside its allowed range" % name)


def _target(value):
    item = _require_object(value, "target")
    if set(item) != {"target_id", "source_paragraph_index", "text_sha256"}:
        _fail("INVALID_SCHEMA", "target fields are not allowed")
    if not _TARGET_ID.match(str(item.get("target_id", ""))):
        _fail("INVALID_SCHEMA", "invalid target_id")
    index = item.get("source_paragraph_index")
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        _fail("INVALID_SCHEMA", "invalid source_paragraph_index")
    if not _SHA256.match(str(item.get("text_sha256", ""))):
        _fail("INVALID_SCHEMA", "invalid text_sha256")


def validate_recognition_result(value):
    item = _require_object(value, "recognition_result")
    allowed = {
        "schema_version", "recognition_engine_version", "document_id",
        "document_revision", "source_sha256", "document_mode",
        "document_mode_confidence", "paragraphs", "review_items",
    }
    required = allowed - {"review_items"}
    if not required.issubset(item) or not set(item).issubset(allowed):
        _fail("INVALID_SCHEMA", "invalid RecognitionResult fields")
    if item.get("schema_version") != PROTOCOL_VERSION:
        _fail("UNSUPPORTED_SCHEMA_VERSION", "RecognitionResult schema version is not supported")
    if not _SHA256.match(str(item.get("source_sha256", ""))):
        _fail("INVALID_SCHEMA", "source_sha256 must be SHA-256")
    _number(item.get("document_mode_confidence"), "document_mode_confidence", 0, 1)
    if item.get("document_mode") not in (
        "unknown", "normal", "report", "notice", "plan", "meeting_minutes",
    ):
        _fail("INVALID_SCHEMA", "unknown document mode")
    paragraphs = item.get("paragraphs")
    if not isinstance(paragraphs, list):
        _fail("INVALID_SCHEMA", "paragraphs must be an array")
    for paragraph in paragraphs:
        _validate_paragraph(paragraph)


def _validate_paragraph(value):
    item = _require_object(value, "paragraph")
    required = {
        "target_id", "source_paragraph_index", "recognized_type", "section_kind",
        "text_sha256", "text_length", "occurrence_index", "confidence",
        "review_level", "needs_review",
    }
    if set(item) != required:
        _fail("INVALID_SCHEMA", "invalid paragraph fields")
    _target({
        "target_id": item["target_id"],
        "source_paragraph_index": item["source_paragraph_index"],
        "text_sha256": item["text_sha256"],
    })
    if item["recognized_type"] not in _RECOGNIZED_TYPES:
        _fail("INVALID_SCHEMA", "unknown recognized type")
    if item["section_kind"] not in _SECTION_KINDS:
        _fail("INVALID_SCHEMA", "unknown section kind")
    if not isinstance(item["text_length"], int) or item["text_length"] < 0:
        _fail("INVALID_SCHEMA", "invalid text_length")
    if not isinstance(item["occurrence_index"], int) or item["occurrence_index"] < 0:
        _fail("INVALID_SCHEMA", "invalid occurrence_index")
    _number(item["confidence"], "confidence", 0, 1)
    if item["review_level"] not in ("confirmed", "info", "review", "critical_review"):
        _fail("INVALID_SCHEMA", "invalid review level")
    if not isinstance(item["needs_review"], bool):
        _fail("INVALID_SCHEMA", "needs_review must be boolean")


def validate_command_request(value):
    _reject_forbidden(value)
    request = _require_object(value, "CommandRequest")
    required = {
        "schema_version", "request_id", "recognition_result", "profile_id",
        "profile_version", "client_capabilities", "product_version",
        "authorization_scope",
    }
    if set(request) != required:
        _fail("INVALID_SCHEMA", "invalid CommandRequest fields")
    if request["schema_version"] != PROTOCOL_VERSION:
        _fail("UNSUPPORTED_SCHEMA_VERSION", "CommandRequest schema version is not supported")
    if not _REQUEST_ID.match(str(request["request_id"])):
        _fail("INVALID_SCHEMA", "invalid request_id")
    if request["authorization_scope"] not in ("classified-offline", "standard-online"):
        _fail("INVALID_SCHEMA", "invalid authorization scope")
    capabilities = _require_object(request["client_capabilities"], "client_capabilities")
    if set(capabilities) != {"schema_version", "capabilities"}:
        _fail("INVALID_SCHEMA", "invalid ClientCapabilities fields")
    if capabilities["schema_version"] != PROTOCOL_VERSION or not isinstance(capabilities["capabilities"], list):
        _fail("INVALID_SCHEMA", "invalid client capabilities")
    validate_recognition_result(request["recognition_result"])


def validate_command(command):
    item = _require_object(command, "command")
    required = {
        "command_id", "kind", "target", "arguments", "required_capability",
        "on_unsupported",
    }
    if set(item) != required:
        _fail("INVALID_COMMAND", "invalid command fields")
    if item["kind"] not in ALLOWED_COMMANDS:
        _fail("UNKNOWN_COMMAND", "command is not allowed")
    if item["required_capability"] != CAPABILITY_BY_COMMAND[item["kind"]]:
        _fail("INVALID_COMMAND", "command capability is invalid")
    if item["on_unsupported"] not in ("skip", "fail"):
        _fail("INVALID_COMMAND", "invalid unsupported policy")
    _target(item["target"])
    arguments = _require_object(item["arguments"], "arguments")
    _validate_arguments(item["kind"], arguments)


def _validate_arguments(kind, arguments):
    allowed_by_kind = {
        "paragraph.set_font": {"east_asia_font_name", "latin_font_name", "font_size_pt", "bold"},
        "paragraph.set_alignment": {"alignment"},
        "paragraph.set_indent": {
            "first_line_indent_chars", "left_indent_chars", "right_indent_chars",
        },
        "paragraph.set_spacing": {"space_before_lines", "space_after_lines", "line_spacing_rule", "line_spacing_pt", "page_break_before", "outline_level"},
        "section.set_page_setup": {
            "page_width_cm", "page_height_cm", "margin_top_cm", "margin_bottom_cm",
            "margin_left_cm", "margin_right_cm", "lines_per_page", "chars_per_line", "grid_alignment", "grid_mode",
        },
    }
    if set(arguments) != allowed_by_kind[kind]:
        _fail("INVALID_PARAMETER", "unexpected command arguments")
    if kind == "paragraph.set_font":
        if not isinstance(arguments["east_asia_font_name"], str) or not arguments["east_asia_font_name"]:
            _fail("INVALID_PARAMETER", "east asia font is required")
        if not isinstance(arguments["latin_font_name"], str) or not arguments["latin_font_name"]:
            _fail("INVALID_PARAMETER", "latin font is required")
        _number(arguments["font_size_pt"], "font_size_pt", 5, 72)
        if not isinstance(arguments["bold"], bool):
            _fail("INVALID_PARAMETER", "bold must be boolean")
    elif kind == "paragraph.set_alignment":
        if arguments["alignment"] not in ALIGNMENTS:
            _fail("INVALID_PARAMETER", "invalid alignment")
    elif kind == "paragraph.set_indent":
        for name in arguments:
            _number(arguments[name], name, 0, 10)
    elif kind == "paragraph.set_spacing":
        _number(arguments["line_spacing_pt"], "line_spacing_pt", 8, 100)
        _number(arguments["space_before_lines"], "space_before_lines", 0, 10)
        _number(arguments["space_after_lines"], "space_after_lines", 0, 10)
        _number(arguments["outline_level"], "outline_level", 1, 10)
        if arguments["line_spacing_rule"] != "exactly" or not isinstance(arguments["page_break_before"], bool):
            _fail("INVALID_PARAMETER", "invalid spacing semantics")
    else:
        _number(arguments["page_width_cm"], "page_width_cm", 10, 60)
        _number(arguments["page_height_cm"], "page_height_cm", 10, 60)
        for name in (
            "margin_top_cm", "margin_bottom_cm", "margin_left_cm", "margin_right_cm",
        ):
            _number(arguments[name], name, 0, 10)
        _number(arguments["lines_per_page"], "lines_per_page", 1, 100)
        _number(arguments["chars_per_line"], "chars_per_line", 1, 200)
        if arguments["grid_alignment"] != "文字对齐字符网络":
            _fail("INVALID_PARAMETER", "invalid grid alignment")
        if arguments["grid_mode"] not in ("natural", "line_only", "strict_lines_and_chars"):
            _fail("INVALID_PARAMETER", "invalid grid mode")


def validate_command_set(value):
    result = _require_object(value, "FormattingCommandSet")
    if set(result) != {"schema_version", "request_id", "service_version", "commands", "warnings"}:
        _fail("INVALID_SCHEMA", "invalid FormattingCommandSet fields")
    if result["schema_version"] != PROTOCOL_VERSION:
        _fail("UNSUPPORTED_SCHEMA_VERSION", "FormattingCommandSet schema version is not supported")
    if not _REQUEST_ID.match(str(result["request_id"])):
        _fail("INVALID_SCHEMA", "invalid request_id")
    if not isinstance(result["commands"], list) or not isinstance(result["warnings"], list):
        _fail("INVALID_SCHEMA", "commands and warnings must be arrays")
    for command in result["commands"]:
        validate_command(command)
