"""Run one real installed-recognizer job through the local file Broker."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import time
import uuid
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.text.paragraph import Paragraph


def paragraphs_from_main_story(document: Document) -> list[dict[str, object]]:
    values: list[dict[str, object]] = []
    body = document.element.body
    for element in body.iter():
        if element.tag != qn("w:p"):
            continue
        parent = element.getparent()
        in_table = False
        while parent is not None:
            if parent.tag == qn("w:tbl"):
                in_table = True
                break
            parent = parent.getparent()
        values.append({"host_paragraph_index": len(values), "raw_text": Paragraph(element, document).text, "story_type": "main", "is_in_table": in_table})
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description="Docxtool installed recognizer/Broker smoke")
    parser.add_argument("source", type=Path)
    parser.add_argument("--timeout", type=float, default=120)
    args = parser.parse_args()
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise SystemExit("APPDATA_UNAVAILABLE")
    root = Path(appdata) / "Docxtool"
    current = json.loads((root / "runtime" / "current.json").read_text(encoding="utf-8"))
    job_id = str(uuid.uuid4())
    job = root / "jobs" / job_id
    job.mkdir(parents=True)
    try:
        source = args.source.resolve()
        paragraphs = paragraphs_from_main_story(Document(str(source)))
        request = {
            "schema_version": 1,
            "request_id": job_id,
            "source_path": str(source),
            "result_path": str(job / "result.json"),
            "error_path": str(job / "error.json"),
            "host_snapshot": {
                "host_type": "wps",
                "document_identity": "broker-smoke",
                "document_revision": "broker-smoke",
                "text_contract_version": "host-text-v1",
                "paragraphs": paragraphs,
            },
        }
        (job / "request.json").write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
        (job / "queued.json").write_text(json.dumps({
            "schema_version": 1,
            "job_id": job_id,
            "contract_version": int(current.get("queue_contract_version", current.get("broker_contract_version", 1))),
            "runtime_version": current["runtime_version"],
            "runtime_sha256": current["executable_sha256"],
            "created_at": "2026-08-06T00:00:00Z",
            "build_id": "broker-smoke",
        }, ensure_ascii=False), encoding="utf-8")
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline and not (job / "result.json").exists() and not (job / "error.json").exists():
            time.sleep(0.25)
        if (job / "error.json").exists():
            error = json.loads((job / "error.json").read_text(encoding="utf-8"))
            raise SystemExit(f"BROKER_SMOKE_{error.get('error_code', 'FAILED')}")
        if not (job / "result.json").exists():
            raise SystemExit("BROKER_SMOKE_TIMEOUT")
        result = json.loads((job / "result.json").read_text(encoding="utf-8"))
        plan = result.get("recognition_plan") or {}
        print(json.dumps({"status": "PASS", "paragraph_count": len(paragraphs), "block_count": len(plan.get("blocks", [])), "binding_count": len((plan.get("binding") or {}).get("blocks", []))}, ensure_ascii=False))
        return 0
    finally:
        shutil.rmtree(job, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
