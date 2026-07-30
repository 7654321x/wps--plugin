"""Generate an intentionally unformatted, non-sensitive WPS visual test fixture."""

from pathlib import Path

from docx import Document
from docx.oxml.ns import qn


fixtures = Path(__file__).resolve().parents[1] / "tests" / "fixtures"
target = fixtures / "wps-e2e-baseline.docx"
target.parent.mkdir(parents=True, exist_ok=True)
document = Document()

# These labels start as plain document paragraphs.  The WPS automatic-format test
# applies every visible property after the user clicks its single test button.
for text in (
    "文档网格验证",
    "左对齐",
    "居中",
    "右对齐",
    "两端对齐：这是用于观察两端对齐效果的脱敏示例文字。",
    "分散对齐：这是用于观察分散对齐效果的脱敏示例文字。",
    "主标题格式",
    "一级标题格式",
    "二级标题格式",
    "三级标题格式：1.测试",
    "四级标题格式：（1）测试",
    "正文格式：仿宋三号、首行缩进 2 字符、固定行距 28 磅。",
    "这是 Chinese English 123456 与中文混合排版测试。",
    "测试两端对齐。",
    "测试分散对齐。",
    "重复段落",
    "重复段落",
    "",
    "称呼格式：各位同志：",
    "日期行格式：2026年7月30日",
    "作者行格式：测试作者",
    "职务姓名格式：测试职务  测试姓名",
    "居中小标题格式",
    "结束语格式",
    "名词解释条目格式：测试名词是脱敏示例。",
    "段前 1 行、段后 0 行",
    "附件说明格式：附件：1.测试材料",
    "附件说明续项格式：2.测试材料",
    "附件正文标记格式：附件1",
    "附件正文标题格式",
    "附件正文格式：这是脱敏附件正文。",
    "落款署名格式：测试单位",
    "落款日期格式：2026年7月30日",
):
    document.add_paragraph(text)

document.add_section()
document.add_paragraph("页面设置：A4、四边距、固定 28 pt 行距、目标每页 22 行；不强制每行 28 字符，字符网格关闭。")
document.add_section()
document.add_paragraph("横向分节测试：此页将在自动测试时设置为横向页面。")

# python-docx seeds every new section with w:docGrid/@linePitch.  WPS can
# interpret that incomplete node as an active character grid, even though no
# character count was requested.  The visual fixture must start genuinely
# grid-free so a later WPS readback cannot confuse baseline inheritance with
# a formatter write.
for section in document.sections:
    section_properties = section._sectPr
    grid = section_properties.find(qn("w:docGrid"))
    if grid is not None:
        section_properties.remove(grid)
document.save(target)
# Named, immutable test inputs/outputs make E2E evidence easy to find.  The
# strict output is intentionally not emitted here: WPS JSAPI 1.0.5 cannot
# persist the full charSpace/linePitch/compatibility contract.
document.save(fixtures / "01-grid-original.docx")
document.save(fixtures / "03-grid-wps-line-only.docx")
document.save(fixtures / "04-grid-rollback-restored.docx")
