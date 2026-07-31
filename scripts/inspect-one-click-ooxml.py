"""Read-only, redacted saved-DOCX inspection for one-click acceptance."""

import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from docx.oxml.ns import qn
from lxml import etree


def _name(font, attribute):
    value = getattr(font, attribute, None)
    return str(value) if value else None


def _is_docxtool_preview(value):
    # Current previews intentionally contain user-facing fields only. Legacy
    # marker detection remains for artifacts created by earlier builds.
    return "[DOCXTOOL_PREVIEW]" in value or (
        "识别结果：" in value
        and "识别状态：" in value
        and "识别置信度：" in value
        and ("中文字体：" in value or "可应用格式：暂无" in value)
    )


def _has_complete_preview_fields(value):
    required = (
        "识别结果：", "中文字体：", "西文字体：", "字号：", "粗体：", "对齐方式：",
        "首行缩进：", "左缩进：", "右缩进：", "段前：", "段后：", "固定行距：",
        "段前分页：", "识别状态：", "识别置信度：",
    )
    return _is_docxtool_preview(value) and all(field in value for field in required)


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
    with ZipFile(path) as archive:
        comments_xml = archive.read("word/comments.xml").decode("utf-8") if "word/comments.xml" in archive.namelist() else ""
        document_xml = archive.read("word/document.xml")
    active_ids = {
        item.get(qn("w:id"))
        for item in etree.fromstring(document_xml).xpath("//w:commentReference", namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"})
    }
    comments_by_id = {}
    if comments_xml:
        root = etree.fromstring(comments_xml.encode("utf-8"))
        for item in root.xpath("//w:comment", namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}):
            comments_by_id[item.get(qn("w:id"))] = {"text": "".join(item.itertext()), "author": item.get(qn("w:author")) or ""}
    active_comments = [comments_by_id.get(comment_id, {"text": "", "author": ""}) for comment_id in active_ids]
    preview_comments = [item for item in active_comments if _is_docxtool_preview(item["text"])]
    preview_comment_count = len(preview_comments)
    complete_preview_count = sum(_has_complete_preview_fields(item["text"]) for item in preview_comments)
    preview_authors = sorted({item["author"] for item in preview_comments if item["author"].startswith("DocxTool·")})
    return {
        "document": path.name,
        "body_sha256": hashlib.sha256("\x1f".join(text_parts).encode("utf-8")).hexdigest(),
        "paragraph_count": len(paragraph_rows), "paragraphs": paragraph_rows, "sections": sections,
        "comments": {
            "total": len(active_comments),
            "docxtool_preview": preview_comment_count,
            "docxtool_preview_complete": complete_preview_count,
            "docxtool_role_author_count": len(preview_authors),
            "docxtool_role_authors": preview_authors,
            "user_owned": len(active_comments) - preview_comment_count,
            "orphaned_definitions": len(set(comments_by_id) - active_ids),
        },
    }


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
