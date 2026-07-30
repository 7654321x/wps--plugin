"""Generate anonymous one-click-format fixtures with intentionally plain text."""

import argparse
from pathlib import Path

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.oxml.ns import qn


FIXTURE_LINES = (
    "Docxtool 一键排版自动验收",
    "主标题测试段落",
    "一、一级标题测试段落",
    "（一）二级标题测试段落",
    "1.三级标题测试段落",
    "（1）四级标题测试段落",
    "普通正文测试段落：这是脱敏示例文字，用于验证正文格式是否写入。",
    "中英文混排正文：Docxtool WPS 123 ABC 与中文混排。",
    "称呼测试段落：各位同志：",
    "附件说明测试段落：附件：1.测试材料",
    "附件正文标题测试段落",
    "附件正文测试段落：仅用于自动验收。",
    "落款署名测试段落：测试单位",
    "落款日期测试段落：2026年7月30日",
    "重复段落测试",
    "重复段落测试",
    "重复段落测试",
    "",
    "已有错误缩进段落：此行从零缩进起始。",
    "已有错误行距段落：此行用于覆盖错误行距。",
    "已有错误字体段落：ABC 123 中文。",
    "左对齐",
    "居中",
    "右对齐",
    "两端对齐：这是用于观察两端对齐效果的脱敏示例文字。",
    "分散对齐：这是用于观察分散对齐效果的脱敏示例文字。",
)


def remove_grids(document):
    for section in document.sections:
        grid = section._sectPr.find(qn("w:docGrid"))
        if grid is not None:
            section._sectPr.remove(grid)


def build_document():
    document = Document()
    for index, text in enumerate(FIXTURE_LINES):
        paragraph = document.add_paragraph()
        # A multi-run paragraph is still intentionally direct-format free.
        if index == 7:
            paragraph.add_run("中英文混排正文：Docxtool ")
            paragraph.add_run("WPS 123 ABC")
            paragraph.add_run(" 与中文混排。")
        else:
            paragraph.add_run(text)
    document.add_section()
    document.add_paragraph("纵向分节测试：该节用于验证多节页面设置。")
    landscape = document.add_section()
    landscape.orientation = WD_ORIENT.LANDSCAPE
    landscape.page_width, landscape.page_height = landscape.page_height, landscape.page_width
    document.add_paragraph("横向分节测试：该节必须在一键排版后保持横向。")
    document.add_section()
    document.add_paragraph("纵横混合多节测试：最后一节恢复纵向。")
    remove_grids(document)
    return document


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "tests" / "fixtures")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    document = build_document()
    # These are plain-text baselines. The WPS host writes the after-format copy.
    for name in ("wps-e2e-baseline.docx", "01-before-format.docx", "02-rollback-test.docx", "03-after-one-click-format.docx"):
        document.save(args.output_dir / name)


if __name__ == "__main__":
    main()
