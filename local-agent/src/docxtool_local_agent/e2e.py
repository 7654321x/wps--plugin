"""Local-only, redacted development E2E session storage."""

import hashlib
import json
from pathlib import Path
from docx import Document
from docxtool.sdk import bind_recognition_plan, recognize_docx
from docxtool_command_service.core.command_builder import build_formatting_commands
from .snapshot import build_host_snapshot


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

# The recognition wheel intentionally preserves its long-lived renderer
# vocabulary (for example ``title`` and ``sign_date``).  The WPS protocol is
# newer and uses its own closed vocabulary.  Keep the translation at this
# boundary so neither the command service nor the WPS executor needs legacy
# field fallbacks.
CONTRACT_TYPE_BY_WHEEL_TYPE = {
    "title": "main_title",
    "title_cont": "title_continuation",
    "addressing": "recipient",
    "sign_org": "signature_org",
    "sign_date": "signature_date",
    "responsibility_line": "body",
    "note": "source_note",
    "__object_caption__": "caption",
}


def contract_type(wheel_type):
    """Return one closed protocol role, safely defaulting prose-like types."""
    value = CONTRACT_TYPE_BY_WHEEL_TYPE.get(str(wheel_type), str(wheel_type))
    return value if value in RECOGNIZED_TYPES else "body"


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


def run_readonly_chain(runtime_root, session_id, include_plan=False):
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
        # The wheel's legacy compatibility result is the renderer contract
        # used by the existing docxtool formatting engine.  It remains the
        # same local SDK entry point, but avoids an authoritative-mode
        # reclassification of deliberately plain E2E fixture paragraphs.
        plan_model = recognize_docx(source, recognition_mode="legacy", include_text=True)
        host_snapshot = build_host_snapshot(
            "docxtool-e2e",
            [
                {
                    "host_paragraph_index": index,
                    "raw_text": text,
                    "story_type": "main",
                    "is_in_table": False,
                }
                for index, text in enumerate(paragraphs)
            ],
            document_identity="e2e-" + before[:16],
            document_revision=before,
        )
        plan = plan_model.to_dict()
        binding = bind_recognition_plan(plan_model, host_snapshot).to_dict()
        after = hashlib.sha256(source.read_bytes()).hexdigest()
        if before != after:
            return {"ok": False, "error_code": "INPUT_FILE_CHANGED"}
        blocks = {item["block_index"]: item for item in plan.get("blocks", [])}
        bindings = {item["block_index"]: item for item in binding.get("blocks", [])}
        grouped = {}
        for block in plan.get("blocks", []):
            physical = block.get("physical_paragraph_index")
            if isinstance(physical, int):
                grouped.setdefault(physical, []).append(block)
        group_complete = {}
        for physical, members in grouped.items():
            expected = max(int(member.get("segment_count_total", 1)) for member in members)
            confirmed = sum(
                1 for member in members
                if bindings.get(member["block_index"], {}).get("binding_status") == "confirmed"
            )
            group_complete[physical] = len(members) == expected and confirmed == expected
        occurrences = {}
        recognition_paragraphs = []
        anchors = []
        for block_index, block in sorted(blocks.items()):
            host_binding = bindings.get(block_index, {})
            binding_status = host_binding.get("binding_status")
            physical = block.get("physical_paragraph_index")
            source_start = block.get("raw_start_utf16")
            source_end = block.get("raw_end_utf16")
            host_index = host_binding.get("host_paragraph_index")
            host_start = host_binding.get("host_raw_start_utf16")
            host_end = host_binding.get("host_raw_end_utf16")
            group_is_complete = group_complete.get(physical) is True
            whole_physical_paragraph = (
                block.get("segment_count_total", 1) == 1
                and source_start == 0
                and source_end == block.get("physical_text_length_utf16")
            )
            applicable = (
                block.get("source_locator_status") == "confirmed"
                and block.get("locator_verified") is True
                and binding_status == "confirmed"
                and group_is_complete
                and whole_physical_paragraph
                and isinstance(host_index, int)
                and isinstance(host_start, int)
                and isinstance(host_end, int)
                and host_end > host_start
            )
            anchors.append({
                "block_index": block_index,
                "physical_paragraph_index": physical,
                "host_paragraph_index": host_index,
                "binding_status": binding_status or "unresolved",
                "group_complete": group_is_complete,
                "formatting_disposition": "apply" if applicable else "skip",
            })
            if not applicable:
                continue
            text_hash = block["raw_fragment_sha256"]
            occurrence = occurrences.get(text_hash, 0)
            occurrences[text_hash] = occurrence + 1
            target_id = "e2e:%s:%d:%d" % (before[:16], host_index, occurrence)
            recognized_type = contract_type(block["type_id"])
            recognition_paragraphs.append({
                "target_id": target_id, "source_paragraph_index": host_index,
                "recognized_type": recognized_type if recognized_type in RECOGNIZED_TYPES else "unknown",
                "section_kind": block["section"] if block["section"] in SECTION_KINDS else "body",
                "text_sha256": text_hash, "text_length": block["text_length_utf16"],
                "occurrence_index": occurrence,
                "confidence": 1,
                "review_level": "confirmed",
                "needs_review": False,
                "physical_paragraph_index": physical,
                "physical_text_sha256": block["physical_text_sha256"],
                "range_start_utf16": source_start,
                "range_end_utf16": source_end,
                "locator_verified": True,
                "mixed_structure": False,
                "formatting_disposition": "apply",
                "host_paragraph_index": host_index,
                "host_raw_start_utf16": host_start,
                "host_raw_end_utf16": host_end,
                "host_raw_text_sha256": hashlib.sha256(paragraphs[host_index].encode("utf-8")).hexdigest(),
                "host_text_contract_version": "host-text-v1",
                "host_canonical_start_utf16": host_binding["host_canonical_start_utf16"],
                "host_canonical_end_utf16": host_binding["host_canonical_end_utf16"],
                "binding_status": "confirmed",
                "binding_confidence": host_binding["binding_confidence"],
                "segment_count_total": 1,
                "segment_count_located": 1,
                "segment_count_confirmed": 1,
            })
        request_payload = {
            "schema_version": "1.0", "request_id": "e2e-" + session_id,
            "recognition_result": {
                "schema_version": "1.2", "recognition_engine_version": plan["engine_version"],
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
        commands = build_formatting_commands(request_payload)
        kinds = [item.get("kind") for item in commands.get("commands", [])]
        allowed = {"paragraph.set_font", "paragraph.set_alignment", "paragraph.set_indent", "paragraph.set_spacing", "section.set_page_setup"}
        if not all(kind in allowed for kind in kinds):
            return {"ok": False, "error_code": "UNKNOWN_COMMAND"}
        result = {"ok": True, "command_count": len(kinds), "anchors": anchors}
        if include_plan:
            # Both payloads are redacted contracts: hashes, indices, role names
            # and format values only. They contain neither document text nor paths.
            result["recognition"] = request_payload["recognition_result"]
            result["commands"] = commands
        return result
    except Exception:
        # The browser receives a stable code only; details stay out of runtime results.
        return {"ok": False, "error_code": "READONLY_CHAIN_FAILED"}
