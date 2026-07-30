"""WSGI adapter shared by local and cloud configuration modes."""

import json

from ..core.validation import CommandServiceError
from .dependencies import build_authenticator
from .routes import capabilities, commands, health, version


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


def create_app(mode, session_token):
    if mode not in ("local", "cloud"):
        raise ValueError("unsupported service mode")
    authenticator = build_authenticator(mode, session_token)

    def app(environ, start_response):
        method = environ.get("REQUEST_METHOD", "")
        path = environ.get("PATH_INFO", "")
        origin = environ.get("HTTP_ORIGIN", "")
        if method == "OPTIONS":
            return _response(start_response, "204 No Content", {}, origin)
        if method == "GET" and path == "/v1/health":
            return _response(start_response, "200 OK", health.payload(), origin)
        if method == "GET" and path == "/v1/capabilities":
            return _response(start_response, "200 OK", capabilities.payload(), origin)
        if method == "GET" and path == "/v1/version":
            return _response(start_response, "200 OK", version.payload(), origin)
        if method == "POST" and path == "/v1/commands":
            headers = {
                "X-Docxtool-Session": environ.get("HTTP_X_DOCXTOOL_SESSION", ""),
                "Authorization": environ.get("HTTP_AUTHORIZATION", ""),
            }
            if not authenticator.authorize(headers):
                return _response(start_response, "401 Unauthorized", {
                    "error": {"code": "UNAUTHORIZED", "message": "invalid service session"},
                }, origin)
            try:
                length = int(environ.get("CONTENT_LENGTH") or "0")
                if length < 1 or length > 4 * 1024 * 1024:
                    raise CommandServiceError("INVALID_REQUEST", "invalid request length")
                payload = json.loads(environ["wsgi.input"].read(length).decode("utf-8"))
                return _response(start_response, "200 OK", commands.handle_commands(payload), origin)
            except CommandServiceError as exc:
                return _response(start_response, "400 Bad Request", {
                    "error": {"code": exc.code, "message": str(exc)},
                }, origin)
            except (UnicodeDecodeError, ValueError, TypeError):
                return _response(start_response, "400 Bad Request", {
                    "error": {"code": "INVALID_JSON", "message": "request must be JSON"},
                }, origin)
        return _response(start_response, "404 Not Found", {
            "error": {"code": "NOT_FOUND", "message": "route not found"},
        }, origin)

    return app
