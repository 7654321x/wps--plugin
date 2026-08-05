"""Hidden WPS debug resource server with a diagnostic-only local log endpoint.

This is deliberately not a business API.  It serves the registered add-in
assets and accepts only JSON diagnostic events from the same add-in origin so
the launcher can show WPS interaction logs in its console.
"""

from __future__ import annotations

import argparse
import json
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import unquote, urlsplit


class WpsDebugHandler(SimpleHTTPRequestHandler):
    server_version = "DocxtoolWpsDebug/1.0"

    @property
    def root(self) -> Path:
        return self.server.root  # type: ignore[attr-defined]

    @property
    def log_path(self) -> Path:
        return self.server.log_path  # type: ignore[attr-defined]

    def _headers(self, content_type: str, length: Optional[int] = None) -> None:
        self.send_header("Content-Type", content_type)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")

    def _send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self._headers(content_type, len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib handler API
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        path = urlsplit(self.path).path
        if path != "/__docxtool_log":
            self._send_bytes(HTTPStatus.NOT_FOUND, b"not found", "text/plain; charset=utf-8")
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > 256 * 1024:
                raise ValueError("invalid diagnostic payload length")
            value = json.loads(self.rfile.read(size).decode("utf-8", errors="replace"))
            if not isinstance(value, dict):
                raise ValueError("diagnostic payload must be an object")
            line = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
            message = str(value.get("message") or value.get("event") or "收到 WPS 日志")
            level = str(value.get("level") or "INFO")
            component = str(value.get("component") or "WPS")
            print("[%s] %s：%s" % (level, component, message), flush=True)
            self._send_bytes(HTTPStatus.NO_CONTENT, b"", "text/plain; charset=utf-8")
        except Exception as error:  # diagnostics must never break the add-in
            self.send_response(HTTPStatus.BAD_REQUEST)
            self._headers("application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(error)}, ensure_ascii=False).encode("utf-8"))

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        path = urlsplit(self.path).path
        if path == "/publish.xml":
            self._send_bytes(HTTPStatus.OK, b"", "text/xml; charset=utf-8")
            return
        if path == "/__docxtool_log":
            self._send_bytes(HTTPStatus.OK, b"{\"status\":\"ready\"}", "application/json; charset=utf-8")
            return
        if path.startswith("/hot-update/"):
            self._send_bytes(HTTPStatus.OK, b"event: ready\ndata: {}\n\n", "text/event-stream")
            return
        # WPS caches debug pages aggressively.  Injecting the official wpsjs
        # hot-update probe and no-store headers keeps the loaded page current.
        if path.endswith((".html", ".htm")) or path in ("", "/"):
            file_path = self._safe_path("index.html" if path in ("", "/") else path.lstrip("/"))
            if file_path and file_path.is_file():
                body = file_path.read_bytes()
                text = body.decode("utf-8", errors="replace")
                if "hot-update-inject.js" not in text:
                    marker = text.find("<body")
                    if marker < 0:
                        marker = text.find("<script")
                    if marker < 0:
                        marker = 0
                    else:
                        marker = text.find(">", marker) + 1
                    text = text[:marker] + '<script src="/hot-update-inject.js"></script>' + text[marker:]
                    body = text.encode("utf-8")
                self._send_bytes(HTTPStatus.OK, body, "text/html; charset=utf-8")
                return
        if path == "/hot-update-inject.js":
            body = b"(function(){try{var s=new EventSource('/hot-update/'+Date.now());s.onmessage=function(e){try{if(JSON.parse(e.data).update)location.reload()}catch(_){}}}catch(_){}})();"
            self._send_bytes(HTTPStatus.OK, body, "application/javascript; charset=utf-8")
            return
        super().do_GET()

    def translate_path(self, path: str) -> str:
        relative = unquote(urlsplit(path).path).lstrip("/")
        safe = self._safe_path(relative)
        return str(safe or self.root / "__missing__")

    def _safe_path(self, relative: str) -> Path | None:
        candidate = (self.root / relative).resolve()
        try:
            candidate.relative_to(self.root.resolve())
        except ValueError:
            return None
        return candidate

    def log_message(self, format: str, *args: object) -> None:
        # Keep access noise out of the WPS interaction log.  Diagnostic events
        # are written explicitly by do_POST and printed in Chinese above.
        return


class WpsDebugServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--log", required=True, type=Path)
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        raise SystemExit("WPS_DEBUG_PACKAGE_MISSING: %s" % root)
    server = WpsDebugServer(("127.0.0.1", args.port), WpsDebugHandler)
    server.root = root  # type: ignore[attr-defined]
    server.log_path = args.log.resolve()  # type: ignore[attr-defined]
    print("Docxtool WPS 调试资源服务已启动：127.0.0.1:%d" % args.port, flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
