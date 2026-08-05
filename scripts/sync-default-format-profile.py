"""Generate the WPS command profile from Docxtool's single default format source."""
import argparse
import hashlib
import json
from importlib import metadata
from pathlib import Path

try:
    from importlib.resources import files
except ImportError:  # Python 3.8
    from importlib_resources import files

SOURCE = files("docxtool.resources").joinpath("config", "default-format.json")
OUT = Path(__file__).resolve().parents[1] / "command-service" / "src" / "docxtool_command_service" / "profiles" / "docxtool-default.json"
MANIFEST = OUT.with_suffix(".manifest.json")
TASKPANE_PROFILE = Path(__file__).resolve().parents[1] / "apps" / "classified-offline" / "ui" / "default-format-profile.js"
SIZE = {"二号": 22, "三号": 16, "四号": 14}
ALIGN = {"左对齐": "left", "居中": "center", "右对齐": "right", "两端对齐": "justify"}
TYPE = {"主标题":"main_title","一级标题":"heading1","二级标题":"heading2","三级标题":"heading3","四级标题":"heading4","正文":"body","称呼":"recipient","日期行":"date_line","作者行":"author_line","职务名称":"role_name","居中小标题":"title2","结束语":"closing","名词解释条目":"glossary_item","附件说明":"attachment_note","附件说明续项":"attachment_note_item","附件正文标记":"attachment_page_mark","附件正文标题":"attachment_title","附件正文":"attachment_body","落款署名":"signature_org","落款日期":"signature_date"}
OUTLINE = {"heading1": 1, "heading2": 2, "heading3": 3, "heading4": 4}

def build(source):
    page = source["page"]
    styles = {}
    for item in source["styles"]:
        type_id = TYPE.get(item["name"])
        if not type_id:
            continue
        styles[type_id] = {
            "style_name": item["name"], "east_asia_font_name": item["font"], "latin_font_name": "Times New Roman",
            "font_size_pt": SIZE.get(item.get("size"), 16), "bold": bool(item.get("bold", False)),
            "alignment": ALIGN.get(item.get("align"), "left"), "first_line_indent_chars": item.get("indent", 0),
            "left_indent_chars": item.get("left_indent", 0), "right_indent_chars": item.get("right_indent", 0),
            "space_before_lines": item.get("spacing_before", page["space_before_line"]), "space_after_lines": item.get("spacing_after", page["space_after_line"]),
            "line_spacing_rule": "exactly", "line_spacing_pt": page["line_spacing_pt"], "page_break_before": bool(item.get("page_break_before", False)),
            "outline_level": OUTLINE.get(type_id, 10),
        }
    body = styles["body"]
    return {"id":"default", "version":"1.0", "source":"src/docxtool/resources/config/default-format.json", "page_setup":{"page_width_cm":page["width_cm"],"page_height_cm":page["height_cm"],"margin_top_cm":page["margin_top_cm"],"margin_bottom_cm":page["margin_bottom_cm"],"margin_left_cm":page["margin_left_cm"],"margin_right_cm":page["margin_right_cm"],"lines_per_page":page["lines_per_page"],"chars_per_line":page["chars_per_line"],"grid_alignment":page["grid_alignment"],"grid_mode":"line_only","normal_east_asia_font_name":body["east_asia_font_name"],"normal_latin_font_name":body["latin_font_name"],"normal_font_size_pt":body["font_size_pt"]}, "styles":styles}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    raw = SOURCE.read_bytes()
    profile = build(json.loads(raw.decode("utf-8")))
    rendered = json.dumps(profile, ensure_ascii=False, indent=2) + "\n"
    manifest = json.dumps({"source_sha256":hashlib.sha256(raw).hexdigest(),"docxtool_version":metadata.version("docxtool"),"profile_version":"1.0"}, ensure_ascii=False, indent=2) + "\n"
    taskpane_profile = (
        "window.DocxtoolDefaultProfile = "
        + json.dumps(profile, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
        + 'if(typeof window.DocxtoolEarlyLog==="function"){window.DocxtoolEarlyLog("DEBUG","main","bootstrap.script.loaded","默认格式配置脚本已执行",{asset:"ui/default-format-profile.js"});}\n'
    )
    if args.check:
        if (not OUT.is_file() or not MANIFEST.is_file() or not TASKPANE_PROFILE.is_file()
                or OUT.read_text(encoding="utf-8") != rendered
                or MANIFEST.read_text(encoding="utf-8") != manifest
                or TASKPANE_PROFILE.read_text(encoding="utf-8") != taskpane_profile):
            raise SystemExit("DEFAULT_PROFILE_OUT_OF_DATE")
        return
    OUT.write_text(rendered, encoding="utf-8")
    MANIFEST.write_text(manifest, encoding="utf-8")
    TASKPANE_PROFILE.write_text(taskpane_profile, encoding="utf-8")


if __name__ == "__main__":
    main()
