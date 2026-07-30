"""Local-only, redacted development E2E session storage."""

import hashlib
import json
from pathlib import Path
from urllib.request import Request, urlopen

from docx import Document
from docxtool.sdk import recognize_docx


RESULT_STATUSES = {"PASS", "FAIL", "UNSUPPORTED", "NOT_RUN"}
OVERALL_STATUSES = {"REAL_WPS_E2E_PASS", "REAL_WPS_E2E_PARTIAL", "REAL_WPS_E2E_NOT_RUN"}
FORBIDDEN_KEYS = {
    "text", "range_text", "source_path", "local_path", "absolute_path", "filename",
    "recognition_result", "command_request", "session_token", "traceback",
}
RECOGNIZED_TYPES = {
    "main_title", "title_continuation", "dispatch_number", "recipient", "body", "heading1", "heading2",
    "heading3", "heading4", "key_value", "meeting_meta", "signature_org", "signature_date", "source_note",
    "embedded_document_title", "attachment_note", "attachment_title", "addressing", "date_line", "author_line",
    "role_name", "title2", "glossary_title", "glossary_item", "attachment_note_item", "attachment_page_mark",
    "attachment_body", "heading1_report", "list", "list_item", "quote", "annotation", "closing", "number",
    "letter", "page_number", "superscript", "caption", "unknown",
}
SECTION_KINDS = {"header", "dispatch_meta", "recipient", "body", "meeting_meta", "signature", "source_note", "embedded_document", "attachment_note", "attachment_body"}


def _session_path(runtime_root):
    return Path(runtime_root) / "current.json"


def load_session(runtime_root):
    path = _session_path(runtime_root)
    if not path.is_file():
        raise ValueError("E2E_SESSION_NOT_FOUND")
    return json.loads(path.read_text(encoding="utf-8"))


def _contains_forbidden(value):
    if isinstance(value, dict):
        return any(key in FORBIDDEN_KEYS or _contains_forbidden(item) for key, item in value.items())
    if isinstance(value, list):
        return any(_contains_forbidden(item) for item in value)
    return False


def record_result(runtime_root, payload):
    if not isinstance(payload, dict):
        raise ValueError("E2E_RESULT_INVALID")
    if _contains_forbidden(payload):
        raise ValueError("E2E_RESULT_REDACTION_FAILED")
    if set(payload) - {"session_id", "stage", "status", "error_code"} or not all(isinstance(value, str) for value in payload.values()):
        raise ValueError("E2E_RESULT_INVALID")
    if payload.get("status") not in RESULT_STATUSES:
        raise ValueError("E2E_RESULT_STATUS_INVALID")
    session = load_session(runtime_root)
    if payload.get("session_id") != session.get("session_id"):
        raise ValueError("E2E_SESSION_MISMATCH")
    results = session.setdefault("test_results", {})
    results[payload["stage"]] = {"status": payload["status"], "error_code": payload.get("error_code", "")}
    session["current_stage"] = payload["stage"]
    session["overall_status"] = "REAL_WPS_E2E_PARTIAL"
    _session_path(runtime_root).write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")
    if payload["stage"] in {
        "paragraph.set_alignment", "paragraph.set_font", "paragraph.set_indent",
        "paragraph.set_spacing", "section.set_page_setup",
    }:
        capability_dir = Path(runtime_root).parent / "capabilities" / session["session_id"]
        capability_dir.mkdir(parents=True, exist_ok=True)
        (capability_dir / (payload["stage"] + ".json")).write_text(json.dumps({
            "wps_version": session.get("wps_version", ""),
            "plugin_version": session.get("plugin_version", ""),
            "wps_jsapi_version": "1.0.5",
            "tested_at": session.get("started_at", ""),
            "capability": payload["stage"],
            "read_passed": payload["status"] == "PASS",
            "write_passed": payload["status"] == "PASS",
            "readback_passed": payload["status"] == "PASS",
            "rollback_passed": payload["status"] == "PASS",
            "status": payload["status"],
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True}


def record_diagnostics(runtime_root, payload):
    if not isinstance(payload, dict) or set(payload) != {"session_id", "diagnostics"}:
        raise ValueError("DIAGNOSTIC_REPORT_INVALID")
    session = load_session(runtime_root)
    if payload["session_id"] != session.get("session_id") or not isinstance(payload["diagnostics"], list):
        raise ValueError("E2E_SESSION_MISMATCH")
    safe = []
    for item in payload["diagnostics"]:
        if not isinstance(item, dict) or set(item) != {"check_id", "group", "status", "error_code", "summary", "duration_ms", "dependencies"}:
            raise ValueError("DIAGNOSTIC_REPORT_INVALID")
        if _contains_forbidden(item) or item["status"] not in RESULT_STATUSES | {"WARN", "UNSUPPORTED", "NOT_RUN"}:
            raise ValueError("E2E_RESULT_REDACTION_FAILED")
        if not all(isinstance(item[key], str) for key in ("check_id", "group", "status", "error_code", "summary")) or not isinstance(item["duration_ms"], int) or not isinstance(item["dependencies"], list):
            raise ValueError("DIAGNOSTIC_REPORT_INVALID")
        safe.append(item)
    session["diagnostics"] = safe
    _session_path(runtime_root).write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "count": len(safe)}


def guard_test_document(runtime_root, session_id, source_path):
    if not isinstance(source_path, str) or not source_path.lower().endswith(".docx"):
        return {"ok": False, "error_code": "E2E_TEST_DOCUMENT_REQUIRED"}
    try:
        session = load_session(runtime_root)
        if session_id != session.get("session_id"):
            return {"ok": False, "error_code": "E2E_SESSION_MISMATCH"}
        metadata_path = Path(runtime_root) / session_id / "test-document.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        candidate = Path(source_path).resolve()
        if metadata.get("working_project_relative"):
            expected = (Path(runtime_root).parents[1] / metadata["working_project_relative"]).resolve()
        else:
            expected = (Path(runtime_root) / session_id / metadata["working_file"]).resolve()
        if candidate != expected or not candidate.is_file() or metadata.get("is_fixture_baseline"):
            return {"ok": False, "error_code": "E2E_TEST_DOCUMENT_REQUIRED"}
        actual_sha256 = hashlib.sha256(candidate.read_bytes()).hexdigest()
        if actual_sha256 != metadata.get("working_sha256"):
            return {"ok": False, "error_code": "E2E_TEST_DOCUMENT_REQUIRED"}
        return {"ok": True}
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        return {"ok": False, "error_code": "E2E_TEST_DOCUMENT_REQUIRED"}


def run_readonly_chain(runtime_root, session_id, command_endpoint, session_token):
    """Run the redacted recognition-to-command flow without exposing a path or token."""
    try:
        session = load_session(runtime_root)
        if session_id != session.get("session_id"):
            return {"ok": False, "error_code": "E2E_SESSION_MISMATCH"}
        metadata = json.loads((Path(runtime_root) / session_id / "test-document.json").read_text(encoding="utf-8"))
        if metadata.get("working_project_relative"):
            source = (Path(runtime_root).parents[1] / metadata["working_project_relative"]).resolve()
        else:
            source = (Path(runtime_root) / session_id / metadata["working_file"]).resolve()
        before = hashlib.sha256(source.read_bytes()).hexdigest()
        paragraphs = [paragraph.text for paragraph in Document(source).paragraphs]
        plan = recognize_docx(source).to_dict()
        after = hashlib.sha256(source.read_bytes()).hexdigest()
        if before != after:
            return {"ok": False, "error_code": "INPUT_FILE_CHANGED"}
        blocks = {item["source_paragraph_index"]: item for item in plan.get("blocks", [])}
        occurrences = {}
        recognition_paragraphs = []
        anchors = []
        for index, paragraph in enumerate(paragraphs):
            block = blocks.get(index)
            if block is None:
                continue
            text_hash = hashlib.sha256(paragraph.encode("utf-8")).hexdigest()
            occurrence = occurrences.get(text_hash, 0)
            occurrences[text_hash] = occurrence + 1
            target_id = "e2e:%s:%d:%d" % (before[:16], index, occurrence)
            recognized_type = "main_title" if block["type_id"] == "title" else block["type_id"]
            recognition_paragraphs.append({
                "target_id": target_id, "source_paragraph_index": index,
                "recognized_type": recognized_type if recognized_type in RECOGNIZED_TYPES else "unknown",
                "section_kind": block["section"] if block["section"] in SECTION_KINDS else "body",
                "text_sha256": text_hash, "text_length": len(paragraph),
                "occurrence_index": occurrence,
                "confidence": 1 if block["review_level"] == "confirmed" else 0.5,
                "review_level": block["review_level"],
                "needs_review": block["review_level"] in ("review", "critical_review"),
            })
            anchors.append({
                "source_paragraph_index": index, "text_sha256": text_hash,
                "occurrence_index": occurrence,
                # A structural role is safe to return to the local taskpane and
                # lets it display the matching normative format without exposing text.
                "recognized_type": recognized_type if recognized_type in RECOGNIZED_TYPES else "unknown",
            })
        request_payload = {
            "schema_version": "1.0", "request_id": "e2e-" + session_id,
            "recognition_result": {
                "schema_version": "1.0", "recognition_engine_version": plan["engine_version"],
                "document_id": "e2e-" + before[:16], "document_revision": before,
                "source_sha256": before, "document_mode": plan["document_mode"],
                "document_mode_confidence": plan["document_mode_confidence"], "paragraphs": recognition_paragraphs,
            },
            "profile_id": "default", "profile_version": "1.0",
            "client_capabilities": {"schema_version": "1.0", "capabilities": [
                "paragraph.font", "paragraph.alignment", "paragraph.indent", "paragraph.spacing", "section.page_setup",
            ]},
            "product_version": session.get("plugin_version", "0.1.0"), "authorization_scope": "classified-offline",
        }
        encoded = json.dumps(request_payload, ensure_ascii=False).encode("utf-8")
        request = Request(command_endpoint.rstrip("/") + "/v1/commands", data=encoded, headers={
            "Content-Type": "application/json", "X-Docxtool-Session": session_token,
        }, method="POST")
        with urlopen(request, timeout=5) as response:
            commands = json.loads(response.read().decode("utf-8"))
        kinds = [item.get("kind") for item in commands.get("commands", [])]
        allowed = {"paragraph.set_font", "paragraph.set_alignment", "paragraph.set_indent", "paragraph.set_spacing", "section.set_page_setup"}
        if not all(kind in allowed for kind in kinds):
            return {"ok": False, "error_code": "UNKNOWN_COMMAND"}
        return {"ok": True, "command_count": len(kinds), "anchors": anchors}
    except Exception:
        # The browser receives a stable code only; details stay out of runtime results.
        return {"ok": False, "error_code": "READONLY_CHAIN_FAILED"}
