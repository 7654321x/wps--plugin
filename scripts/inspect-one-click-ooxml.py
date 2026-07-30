"""Read-only, redacted saved-DOCX inspection for one-click acceptance."""

import argparse
import hashlib
import json
from pathlib import Path

from docx import Document


def _name(font, attribute):
    value = getattr(font, attribute, None)
    return str(value) if value else None


def inspect(path):
    document = Document(path)
    paragraph_rows = []
    text_parts = []
    for index, paragraph in enumerate(document.paragraphs):
        text = paragraph.text
        text_parts.append(text)
        fmt = paragraph.paragraph_format
        run_rows = [{
            "east_asia_font": _name(run.font, "name"), "font_size_pt": float(run.font.size.pt) if run.font.size else None,
            "bold": run.font.bold,
        } for run in paragraph.runs]
        paragraph_rows.append({
            "index": index, "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(), "text_length": len(text),
            "alignment": str(paragraph.alignment), "first_line_indent_pt": float(fmt.first_line_indent.pt) if fmt.first_line_indent else 0,
            "left_indent_pt": float(fmt.left_indent.pt) if fmt.left_indent else 0, "right_indent_pt": float(fmt.right_indent.pt) if fmt.right_indent else 0,
            "space_before_pt": float(fmt.space_before.pt) if fmt.space_before else 0, "space_after_pt": float(fmt.space_after.pt) if fmt.space_after else 0,
            "line_spacing": float(fmt.line_spacing) if isinstance(fmt.line_spacing, (int, float)) else str(fmt.line_spacing),
            "page_break_before": bool(fmt.page_break_before), "runs": run_rows,
        })
    sections = [{
        "index": index, "orientation": str(section.orientation), "page_width_pt": float(section.page_width.pt), "page_height_pt": float(section.page_height.pt),
        "margin_top_pt": float(section.top_margin.pt), "margin_bottom_pt": float(section.bottom_margin.pt),
        "margin_left_pt": float(section.left_margin.pt), "margin_right_pt": float(section.right_margin.pt),
    } for index, section in enumerate(document.sections)]
    return {"document": path.name, "body_sha256": hashlib.sha256("\x1f".join(text_parts).encode("utf-8")).hexdigest(), "paragraph_count": len(paragraph_rows), "paragraphs": paragraph_rows, "sections": sections}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("docx", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    data = inspect(args.docx)
    rendered = json.dumps(data, ensure_ascii=False, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(rendered + "\n", encoding="utf-8")
    else:
        print(rendered)
