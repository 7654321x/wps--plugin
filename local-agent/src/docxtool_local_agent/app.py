"""Small HTTP boundary; it never logs or returns document text or paths."""

import hashlib
import json
import os
from pathlib import Path
import tempfile

from docx import Document

from docxtool import __version__ as DOCXTOOL_PACKAGE_VERSION
from docxtool.document.source_tape import HOST_TEXT_CONTRACT_VERSION, SOURCE_LOCATOR_VERSION
from .e2e import guard_test_document, load_session, record_diagnostics, record_result, run_readonly_chain

from docxtool.sdk import (
    RecognitionInputError,
    RecognitionSdkError,
    bind_recognition_plan,
    recognize_docx,
)
from docxtool_command_service.core.command_builder import build_formatting_commands
from docxtool_command_service.core.validation import CommandServiceError
from .snapshot import build_host_snapshot


MAX_REQUEST_BYTES = 32 * 1024
MAX_RECOGNITION_REQUEST_BYTES = 8 * 1024 * 1024
MAX_COMMAND_REQUEST_BYTES = 4 * 1024 * 1024
DEVELOPMENT_ORIGIN = "http://127.0.0.1:3889"


def _response(start_response, status, payload, origin=""):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = [
        ("Content-Type", "application/json; charset=utf-8"),
        ("Content-Length", str(len(body))),
    ]
    if origin == DEVELOPMENT_ORIGIN:
        headers.append(("Access-Control-Allow-Origin", origin))
        headers.append(("Access-Control-Allow-Methods", "GET, POST, OPTIONS"))
        headers.append(("Access-Control-Allow-Headers", "Content-Type, X-Docxtool-Session, Authorization"))
        headers.append(("Vary", "Origin"))
    start_response(status, headers)
    return [body]


def _recognized_plan(source_path, host_snapshot):
    # The wheel's legacy compatibility mode is its established rendering
    # vocabulary.  The WPS adapter translates that closed vocabulary to the
    # newer protocol types; authoritative mode currently reclassifies plain
    # title fixtures to body before the adapter can preserve their role.
    plan = recognize_docx(
        source_path,
        recognition_mode="legacy",
        include_text=True,
        include_raw_text=True,
    )
    return plan.to_dict(), bind_recognition_plan(plan, host_snapshot).to_dict()


def _recognition_handshake():
    """Exercise the installed wheel and host binder without opening user data."""
    descriptor, temporary_path = tempfile.mkstemp(prefix="docxtool-handshake-", suffix=".docx")
    os.close(descriptor)
    try:
        document = Document()
        document.add_paragraph("DocxTool local handshake")
        document.save(temporary_path)
        plan = recognize_docx(temporary_path, recognition_mode="legacy", include_text=True)
        binding = bind_recognition_plan(
            plan,
            build_host_snapshot(
                "local-agent-handshake",
                [{"host_paragraph_index": 0, "raw_text": "DocxTool local handshake"}],
            ),
        )
        if len(plan.blocks) != 1 or len(binding.blocks) != 1 or binding.blocks[0].binding_status != "confirmed":
            raise RecognitionSdkError("HANDSHAKE_BINDING_FAILED", "local binding handshake failed")
        return {
            "ok": True,
            "package_version": DOCXTOOL_PACKAGE_VERSION,
            "locator_version": SOURCE_LOCATOR_VERSION,
            "host_text_contract_version": HOST_TEXT_CONTRACT_VERSION,
        }
    finally:
        try:
            os.unlink(temporary_path)
        except OSError:
            pass


def _host_snapshot(value):
    """Validate the local WPS snapshot shape without persisting its text."""
    if not isinstance(value, dict):
        raise ValueError("HOST_SNAPSHOT_REQUIRED")
    if set(value) - {
        "host_type", "document_identity", "document_revision", "text_contract_version", "paragraphs",
    }:
        raise ValueError("INVALID_HOST_SNAPSHOT")
    paragraphs = value.get("paragraphs")
    if not isinstance(value.get("host_type"), str) or not value["host_type"]:
        raise ValueError("INVALID_HOST_SNAPSHOT")
    if not isinstance(paragraphs, list):
        raise ValueError("INVALID_HOST_SNAPSHOT")
    if len(paragraphs) > 100000:
        raise ValueError("HOST_SNAPSHOT_TOO_LARGE")
    normalized = []
    for item in paragraphs:
        if not isinstance(item, dict) or set(item) - {
            "host_paragraph_index", "raw_text", "story_type", "is_in_table",
        }:
            raise ValueError("INVALID_HOST_SNAPSHOT")
        if not isinstance(item.get("host_paragraph_index"), int) or item["host_paragraph_index"] < 0:
            raise ValueError("INVALID_HOST_SNAPSHOT")
        if not isinstance(item.get("raw_text"), str):
            raise ValueError("INVALID_HOST_SNAPSHOT")
        if len(item["raw_text"].encode("utf-8")) > MAX_REQUEST_BYTES:
            raise ValueError("HOST_PARAGRAPH_TOO_LARGE")
        is_in_table = item.get("is_in_table", False)
        if not isinstance(is_in_table, bool):
            raise ValueError("INVALID_HOST_SNAPSHOT")
        normalized.append({
            "host_paragraph_index": item["host_paragraph_index"],
            "raw_text": item["raw_text"],
            "story_type": str(item.get("story_type", "main") or "main"),
            "is_in_table": is_in_table,
        })
    if value.get("text_contract_version", HOST_TEXT_CONTRACT_VERSION) != HOST_TEXT_CONTRACT_VERSION:
        raise ValueError("INVALID_HOST_SNAPSHOT")
    return build_host_snapshot(
        value["host_type"],
        normalized,
        document_identity=value.get("document_identity"),
        document_revision=value.get("document_revision"),
    )


def create_app(session_token, e2e_runtime=None):
    """Return the single loopback API used by the classified WPS add-in."""
    def app(environ, start_response):
        method = environ.get("REQUEST_METHOD", "")
        path = environ.get("PATH_INFO", "")
        origin = environ.get("HTTP_ORIGIN", "")
        if method == "OPTIONS":
            return _response(start_response, "204 No Content", {}, origin)
        if method == "GET" and path == "/v1/health":
            return _response(start_response, "200 OK", {"ok": True}, origin)
        if method == "GET" and path == "/v1/version":
            return _response(start_response, "200 OK", {
                "recognition_sdk": "docxtool.sdk.recognize_docx",
                "agent_version": "0.2.0",
                "package_version": DOCXTOOL_PACKAGE_VERSION,
                "locator_version": SOURCE_LOCATOR_VERSION,
                "host_text_contract_version": HOST_TEXT_CONTRACT_VERSION,
            }, origin)
        if method == "GET" and path == "/v1/handshake":
            try:
                return _response(start_response, "200 OK", _recognition_handshake(), origin)
            except (OSError, RecognitionInputError, RecognitionSdkError, ValueError, TypeError):
                return _response(start_response, "503 Service Unavailable", {
                    "ok": False,
                    "error_code": "RECOGNITION_HANDSHAKE_FAILED",
                }, origin)
        if e2e_runtime and method == "GET" and path == "/v1/e2e/session":
            try:
                session = load_session(e2e_runtime)
                safe = {key: session.get(key) for key in ("session_id", "edition", "plugin_version", "started_at", "current_stage", "overall_status", "test_results")}
                return _response(start_response, "200 OK", safe, origin)
            except ValueError as exc:
                return _response(start_response, "404 Not Found", {"error": {"code": str(exc)}}, origin)
        if e2e_runtime and method == "POST" and path == "/v1/e2e/result":
            try:
                length = int(environ.get("CONTENT_LENGTH") or "0")
                payload = json.loads(environ["wsgi.input"].read(length).decode("utf-8"))
                return _response(start_response, "200 OK", record_result(e2e_runtime, payload), origin)
            except (UnicodeDecodeError, ValueError, TypeError) as exc:
                return _response(start_response, "400 Bad Request", {"error": {"code": str(exc)}}, origin)
        if e2e_runtime and method == "POST" and path == "/v1/e2e/diagnostics":
            try:
                length = int(environ.get("CONTENT_LENGTH") or "0")
                payload = json.loads(environ["wsgi.input"].read(length).decode("utf-8"))
                return _response(start_response, "200 OK", record_diagnostics(e2e_runtime, payload), origin)
            except (UnicodeDecodeError, ValueError, TypeError) as exc:
                return _response(start_response, "400 Bad Request", {"error": {"code": str(exc)}}, origin)
        if e2e_runtime and method == "POST" and path == "/v1/e2e/guard":
            try:
                length = int(environ.get("CONTENT_LENGTH") or "0")
                payload = json.loads(environ["wsgi.input"].read(length).decode("utf-8"))
                result = guard_test_document(e2e_runtime, payload.get("session_id"), payload.get("source_path"))
                return _response(start_response, "200 OK", result, origin)
            except (UnicodeDecodeError, ValueError, TypeError):
                return _response(start_response, "400 Bad Request", {"ok": False, "error_code": "E2E_TEST_DOCUMENT_REQUIRED"}, origin)
        if e2e_runtime and method == "POST" and path == "/v1/e2e/read-only":
            try:
                length = int(environ.get("CONTENT_LENGTH") or "0")
                payload = json.loads(environ["wsgi.input"].read(length).decode("utf-8"))
                result = run_readonly_chain(e2e_runtime, payload.get("session_id"))
                return _response(start_response, "200 OK", result, origin)
            except (UnicodeDecodeError, ValueError, TypeError):
                return _response(start_response, "400 Bad Request", {"ok": False, "error_code": "READONLY_CHAIN_FAILED"}, origin)
        if e2e_runtime and method == "POST" and path == "/v1/e2e/format-plan":
            try:
                length = int(environ.get("CONTENT_LENGTH") or "0")
                payload = json.loads(environ["wsgi.input"].read(length).decode("utf-8"))
                result = run_readonly_chain(e2e_runtime, payload.get("session_id"), include_plan=True)
                return _response(start_response, "200 OK", result, origin)
            except (UnicodeDecodeError, ValueError, TypeError):
                return _response(start_response, "400 Bad Request", {"ok": False, "error_code": "FORMAT_PLAN_FAILED"}, origin)
        if method == "POST" and path == "/v1/commands":
            if environ.get("HTTP_X_DOCXTOOL_SESSION", "") != session_token:
                return _response(start_response, "401 Unauthorized", {
                    "error": {"code": "UNAUTHORIZED"},
                }, origin)
            try:
                length = int(environ.get("CONTENT_LENGTH") or "0")
                if length < 1 or length > MAX_COMMAND_REQUEST_BYTES:
                    raise CommandServiceError("INVALID_REQUEST", "invalid request length")
                request = json.loads(environ["wsgi.input"].read(length).decode("utf-8"))
                return _response(start_response, "200 OK", build_formatting_commands(request), origin)
            except CommandServiceError as exc:
                return _response(start_response, "400 Bad Request", {
                    "error": {"code": exc.code, "message": str(exc)},
                }, origin)
            except (UnicodeDecodeError, ValueError, TypeError):
                return _response(start_response, "400 Bad Request", {
                    "error": {"code": "INVALID_JSON", "message": "request must be JSON"},
                }, origin)
        if method != "POST" or path != "/v1/recognize":
            return _response(start_response, "404 Not Found", {
                "error": {"code": "NOT_FOUND"},
            }, origin)
        if environ.get("HTTP_X_DOCXTOOL_SESSION", "") != session_token:
            return _response(start_response, "401 Unauthorized", {
                "error": {"code": "UNAUTHORIZED"},
            }, origin)
        try:
            length = int(environ.get("CONTENT_LENGTH") or "0")
            if length < 1 or length > MAX_RECOGNITION_REQUEST_BYTES:
                raise ValueError("invalid request length")
            request = json.loads(environ["wsgi.input"].read(length).decode("utf-8"))
            if set(request) != {"source_path", "host_snapshot"} or not isinstance(request["source_path"], str):
                raise ValueError("invalid request")
            source = Path(request["source_path"]).expanduser()
            if source.suffix.lower() != ".docx" or not source.is_file():
                return _response(start_response, "400 Bad Request", {
                    "error": {"code": "INVALID_DOCX_INPUT"},
                }, origin)
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            host_snapshot = _host_snapshot(request["host_snapshot"])
            result, binding = _recognized_plan(source, host_snapshot)
            after = hashlib.sha256(source.read_bytes()).hexdigest()
            if before != after:
                return _response(start_response, "500 Internal Server Error", {
                    "error": {"code": "INPUT_FILE_CHANGED"},
                }, origin)
            return _response(start_response, "200 OK", {"data": result, "binding": binding}, origin)
        except (RecognitionInputError, RecognitionSdkError) as exc:
            return _response(start_response, "400 Bad Request", {
                "error": {"code": exc.code},
            }, origin)
        except (UnicodeDecodeError, ValueError, TypeError):
            return _response(start_response, "400 Bad Request", {
                "error": {"code": "INVALID_REQUEST"},
            }, origin)
    return app
