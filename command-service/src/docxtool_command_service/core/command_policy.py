"""The complete, first-phase command allowlist and bounded argument policy."""

ALLOWED_COMMANDS = frozenset(
    (
        "paragraph.set_font",
        "paragraph.set_alignment",
        "paragraph.set_indent",
        "paragraph.set_spacing",
        "section.set_page_setup",
    )
)

CAPABILITY_BY_COMMAND = {
    "paragraph.set_font": "paragraph.font",
    "paragraph.set_alignment": "paragraph.alignment",
    "paragraph.set_indent": "paragraph.indent",
    "paragraph.set_spacing": "paragraph.spacing",
    "section.set_page_setup": "section.page_setup",
}

ALIGNMENTS = frozenset(("left", "center", "right", "justify", "distributed"))
FORBIDDEN_FIELD_NAMES = frozenset(
    (
        "text",
        "raw_text",
        "original_text",
        "paragraph_text",
        "document_content",
        "file_content",
        "file_base64",
        "local_path",
        "absolute_path",
        "javascript",
        "python_code",
        "script",
        "code",
    )
)
