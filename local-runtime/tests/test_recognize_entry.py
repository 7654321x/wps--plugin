from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def load_module():
    spec = importlib.util.spec_from_file_location("recognize_entry", ROOT / "recognize_entry.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_help(capsys):
    module = load_module()
    with pytest.raises(SystemExit) as exc:
      module.main(["--help"])
    assert exc.value.code == 0
    captured = capsys.readouterr()
    assert "docxtool-recognize" in captured.out


def test_invalid_request_writes_error(tmp_path):
    module = load_module()
    request = tmp_path / "request.json"
    result = tmp_path / "result.json"
    error = tmp_path / "error.json"
    request.write_text(json.dumps({"schema_version": 0}), encoding="utf-8")
    assert module.main(["--request", str(request), "--result", str(result), "--error", str(error)]) == 1
    payload = json.loads(error.read_text(encoding="utf-8"))
    assert payload["error_code"] == "INVALID_REQUEST"


def test_success_builds_plan_and_binding(tmp_path, monkeypatch):
    module = load_module()
    source = tmp_path / "sample.docx"
    source.write_bytes(b"fake-docx")
    request = tmp_path / "request.json"
    result = tmp_path / "result.json"
    error = tmp_path / "error.json"
    request.write_text(json.dumps({
        "schema_version": 1,
        "request_id": "req-1",
        "source_path": str(source),
        "result_path": str(result),
        "error_path": str(error),
        "host_snapshot": {
            "host_type": "wps",
            "document_identity": "doc-1",
            "document_revision": "rev-1",
            "text_contract_version": "host-text-v1",
            "paragraphs": [{"host_paragraph_index": 0, "raw_text": "测试段落", "story_type": "main", "is_in_table": False}],
        },
    }), encoding="utf-8")

    class FakePlan:
        def to_dict(self):
            return {
                "schema_version": "1.0",
                "engine_version": "4.0",
                "document_mode": "normal",
                "document_mode_confidence": 1,
                "blocks": [],
            }

    class FakeBinding:
        def to_dict(self):
            return {"host_text_contract_version": "host-text-v1", "blocks": []}

    monkeypatch.setattr(module, "recognize_docx", lambda *args, **kwargs: FakePlan())
    monkeypatch.setattr(module, "bind_recognition_plan", lambda *args, **kwargs: FakeBinding())
    assert module.main(["--request", str(request), "--result", str(result), "--error", str(error)]) == 0
    payload = json.loads(result.read_text(encoding="utf-8"))
    assert payload["request_id"] == "req-1"
    assert payload["recognition_plan"]["binding"]["host_text_contract_version"] == "host-text-v1"
    assert not error.exists()
