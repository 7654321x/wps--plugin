"""Small HTTP boundary; it never logs or returns document text or paths."""

import hashlib
import json
from pathlib import Path

from .e2e import guard_test_document, load_session, record_diagnostics, record_result, run_readonly_chain

from docxtool.sdk import RecognitionInputError, RecognitionSdkError, recognize_docx


MAX_REQUEST_BYTES = 32 * 1024
DEVELOPMENT_ORIGIN = "http://127.0.0.1:3890"


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


def _recognized_plan(source_path):
    plan = recognize_docx(source_path)
    return plan.to_dict()


def create_app(session_token, e2e_runtime=None, command_endpoint=""):
    """Return a loopback WSGI application with short-lived token authentication."""
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
                result = run_readonly_chain(e2e_runtime, payload.get("session_id"), command_endpoint, session_token)
                return _response(start_response, "200 OK", result, origin)
            except (UnicodeDecodeError, ValueError, TypeError):
                return _response(start_response, "400 Bad Request", {"ok": False, "error_code": "READONLY_CHAIN_FAILED"}, origin)
        if method != "POST" or path != "/v1/recognize":
            return _response(start_response, "404 Not Found", {
                "error": {"code": "NOT_FOUND"},
            }, origin)
        if environ.get("HTTP_X_DOCTOOL_SESSION", "") != session_token:
            return _response(start_response, "401 Unauthorized", {
                "error": {"code": "UNAUTHORIZED"},
            }, origin)
        try:
            length = int(environ.get("CONTENT_LENGTH") or "0")
            if length < 1 or length > MAX_REQUEST_BYTES:
                raise ValueError("invalid request length")
            request = json.loads(environ["wsgi.input"].read(length).decode("utf-8"))
            if set(request) != {"source_path"} or not isinstance(request["source_path"], str):
                raise ValueError("invalid request")
            source = Path(request["source_path"]).expanduser()
            if source.suffix.lower() != ".docx" or not source.is_file():
                return _response(start_response, "400 Bad Request", {
                    "error": {"code": "INVALID_DOCX_INPUT"},
                }, origin)
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            result = _recognized_plan(source)
            after = hashlib.sha256(source.read_bytes()).hexdigest()
            if before != after:
                return _response(start_response, "500 Internal Server Error", {
                    "error": {"code": "INPUT_FILE_CHANGED"},
                }, origin)
            return _response(start_response, "200 OK", {"data": result}, origin)
        except (RecognitionInputError, RecognitionSdkError) as exc:
            return _response(start_response, "400 Bad Request", {
                "error": {"code": exc.code},
            }, origin)
        except (UnicodeDecodeError, ValueError, TypeError):
            return _response(start_response, "400 Bad Request", {
                "error": {"code": "INVALID_REQUEST"},
            }, origin)
    return app
