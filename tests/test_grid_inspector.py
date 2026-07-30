import importlib.util
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "inspect-grid-ooxml.py"
GENERATOR = ROOT / "scripts" / "generate-e2e-fixture.py"


def _module():
    spec = importlib.util.spec_from_file_location("grid_inspector", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_grid_inspector_reports_a_genuinely_grid_free_line_only_fixture():
    subprocess.run([sys.executable, str(GENERATOR)], check=True)
    report = _module().inspect(ROOT / "tests" / "fixtures" / "03-grid-wps-line-only.docx")
    assert report["character_grid_enabled"] is False
    assert all(item["type"] == "none" for item in report["sections"])
    assert all(item["char_space"] is None for item in report["sections"])
    assert all(item["line_pitch"] is None for item in report["sections"])
    assert report["stretching_run_count"] == 0
    assert report["distributed_paragraph_count"] == 0
