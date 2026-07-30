"""Read-only OOXML inspection for WPS page-grid acceptance evidence.

The report intentionally excludes paragraph text.  It verifies the fields that
can reveal glyph stretching after a WPS save: document grids, run scaling and
spacing, paragraph snap-to-grid, and distributed alignment.
"""

import argparse
import json
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def attr(element, name, default=None):
    return element.get(W + name, default) if element is not None else default


def inspect(path):
    with ZipFile(path) as package:
        document = ET.fromstring(package.read("word/document.xml"))
        styles = ET.fromstring(package.read("word/styles.xml")) if "word/styles.xml" in package.namelist() else None
        settings = ET.fromstring(package.read("word/settings.xml")) if "word/settings.xml" in package.namelist() else None
    grids = []
    for section_index, section in enumerate(document.findall(".//" + W + "sectPr"), 1):
        grid = section.find(W + "docGrid")
        grids.append({
            "section": section_index,
            "type": attr(grid, "type", "none"),
            "chars_per_line": attr(grid, "charsPerLine"),
            "lines_per_page": attr(grid, "linesPerPage"),
            "char_space": attr(grid, "charSpace"),
            "line_pitch": attr(grid, "linePitch"),
            "character_grid_enabled": attr(grid, "type") in ("linesAndChars", "genko"),
        })
    stretching_runs = 0
    snap_to_grid = {"enabled": 0, "disabled": 0}
    distributed_paragraphs = 0
    justify_paragraphs = 0
    paragraph_count = 0
    for paragraph in document.findall(".//" + W + "p"):
        paragraph_count += 1
        props = paragraph.find(W + "pPr")
        if props is not None:
            snap = props.find(W + "snapToGrid")
            if snap is not None:
                snap_to_grid["enabled" if attr(snap, "val", "1") not in ("0", "false") else "disabled"] += 1
            jc = props.find(W + "jc")
            if attr(jc, "val") == "distribute":
                distributed_paragraphs += 1
            if attr(jc, "val") == "both":
                justify_paragraphs += 1
        for run_props in paragraph.findall(".//" + W + "rPr"):
            spacing = run_props.find(W + "spacing")
            width = run_props.find(W + "w")
            fit = run_props.find(W + "fitText")
            if attr(spacing, "val", "0") != "0" or attr(width, "val", "100") != "100" or fit is not None:
                stretching_runs += 1
    compat = []
    if settings is not None:
        for item in settings.findall(".//" + W + "compatSetting"):
            compat.append({"name": attr(item, "name"), "value": attr(item, "val")})
    normal = {"east_asia_font": None, "latin_font": None, "size_half_points": None}
    if styles is not None:
        normal_style = next((item for item in styles.findall(W + "style") if attr(item, "styleId") == "Normal"), None)
        if normal_style is not None:
            fonts = normal_style.find(".//" + W + "rFonts")
            size = normal_style.find(".//" + W + "sz")
            normal = {"east_asia_font": attr(fonts, "eastAsia"), "latin_font": attr(fonts, "ascii"), "size_half_points": attr(size, "val")}
    return {
        "document": path.name,
        "paragraph_count": paragraph_count,
        "sections": grids,
        "character_grid_enabled": any(item["character_grid_enabled"] for item in grids),
        "stretching_run_count": stretching_runs,
        "snap_to_grid": snap_to_grid,
        "distributed_paragraph_count": distributed_paragraphs,
        "justify_paragraph_count": justify_paragraphs,
        "normal": normal,
        "compat_settings": compat,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("docx", type=Path)
    args = parser.parse_args()
    print(json.dumps(inspect(args.docx), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
