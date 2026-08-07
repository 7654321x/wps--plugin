"""Loopback WPS resource server with one diagnostic log boundary.

The server is intentionally a static file server.  The bytes returned for
``index.html`` and the other add-in assets must be the bytes produced by the
current build; no hot-reload script, re-encoding, or SPA fallback is allowed.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
from typing import Dict, Optional
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from wps_logging import UnifiedLogWriter  # noqa: E402


CRITICAL_ASSETS = (
    "index.html",
    "main.js",
    "host-runtime.js",
    "js/ribbon.js",
)
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".xml": "application/xml; charset=utf-8",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def asset_summary(root: Path) -> Dict[str, Dict[str, object]]:
    summaries: Dict[str, Dict[str, object]] = {}
    for relative in CRITICAL_ASSETS:
        path = root / relative
        if not path.is_file():
            continue
        content = path.read_bytes()
        summaries[relative] = {
            "bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    return summaries


def _short_user_agent(value: str) -> str:
    lowered = value.casefold()
    if "wps" in lowered or "kingsoft" in lowered:
        return "WPS"
    if "edge" in lowered:
        return "Edge"
    if "chrome" in lowered:
        return "Chrome"
    if "firefox" in lowered:
        return "Firefox"
    return "其他"


class WpsDebugHandler(SimpleHTTPRequestHandler):
    server_version = "DocxtoolWpsDebug/1.1"

    @property
    def root(self) -> Path:
        return self.server.root  # type: ignore[attr-defined]

    @property
    def log_writer(self) -> UnifiedLogWriter:
        return self.server.log_writer  # type: ignore[attr-defined]

    @property
    def build_id(self) -> str:
        return str(self.server.build_id)  # type: ignore[attr-defined]

    @property
    def asset_metadata(self) -> Dict[str, Dict[str, object]]:
        return self.server.asset_metadata  # type: ignore[attr-defined]

    def _headers(self, content_type: str, length: Optional[int] = None) -> None:
        self.send_header("Content-Type", content_type)
        if length is not None:
            self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")

    def _send_bytes(self, status: int, body: bytes, content_type: str, *, send_body: bool = True) -> None:
        self.send_response(status)
        self._headers(content_type, len(body))
        self.end_headers()
        if send_body and body:
            self.wfile.write(body)

    def _log(self, level: str, event: str, message: str, data: Optional[Dict[str, object]] = None) -> None:
        self.log_writer.append(
            [
                {
                    "timestamp": utc_now(),
                    "level": level,
                    "component": "debug_server",
                    "event": event,
                    "message": message,
                    "build_id": self.build_id,
                    "data": data or {},
                }
            ]
        )

    def _request_data(self, relative: str) -> Dict[str, object]:
        source = self.client_address[0] if self.client_address else ""
        return {
            "resource_path": relative,
            "source_address": source if source in ("127.0.0.1", "::1") else "非本机",
            "user_agent": _short_user_agent(self.headers.get("User-Agent", "")),
        }

    def _is_internal_probe(self) -> bool:
        return self.headers.get("X-Docxtool-Probe") == "1"

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
        except ValueError:
            self._send_bytes(HTTPStatus.BAD_REQUEST, b"WPS_DIAGNOSTIC_LENGTH_INVALID", "text/plain; charset=utf-8")
            return
        if size <= 0 or size > 256 * 1024:
            self._send_bytes(HTTPStatus.BAD_REQUEST, b"WPS_DIAGNOSTIC_LENGTH_INVALID", "text/plain; charset=utf-8")
            return
        try:
            value = json.loads(self.rfile.read(size).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_bytes(HTTPStatus.BAD_REQUEST, b"WPS_DIAGNOSTIC_JSON_INVALID", "text/plain; charset=utf-8")
            return
        if not isinstance(value, dict):
            self._send_bytes(HTTPStatus.BAD_REQUEST, b"WPS_DIAGNOSTIC_OBJECT_REQUIRED", "text/plain; charset=utf-8")
            return
        self.log_writer.append([value])
        self._send_bytes(HTTPStatus.NO_CONTENT, b"", "text/plain; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        path = urlsplit(self.path).path
        if path == "/publish.xml":
            self._send_bytes(HTTPStatus.OK, b"", "text/xml; charset=utf-8")
            return
        if path == "/__docxtool_log":
            self._send_bytes(HTTPStatus.OK, b'{"status":"ready"}', "application/json; charset=utf-8")
            return
        self._serve_static(send_body=True)

    def do_HEAD(self) -> None:  # noqa: N802 - stdlib handler API
        self._serve_static(send_body=False)

    def _serve_static(self, *, send_body: bool) -> None:
        path = urlsplit(self.path).path
        relative = "index.html" if path in ("", "/") else unquote(path).lstrip("/")
        file_path = self._safe_path(relative)
        if file_path is None or not file_path.is_file() or file_path.is_dir() or relative.endswith("/"):
            if relative == "index.html":
                self._log(
                    "ERROR",
                    "wps.resource.index.failed",
                    "WPS 主资源文件不存在",
                    {"stable_error_code": "WPS_RESOURCE_INDEX_SERVE_FAILED", **self._request_data(relative)},
                )
            self._send_bytes(HTTPStatus.NOT_FOUND, b"WPS_RESOURCE_NOT_FOUND", "text/plain; charset=utf-8", send_body=send_body)
            return

        if relative == "index.html" and not self._is_internal_probe():
            self._log("INFO", "wps.resource.index.requested", "WPS 已请求插件主页面", self._request_data(relative))
        try:
            body = file_path.read_bytes()
        except OSError:
            if relative == "index.html":
                self._log(
                    "ERROR",
                    "wps.resource.index.failed",
                    "WPS 主资源读取失败",
                    {"stable_error_code": "WPS_RESOURCE_INDEX_SERVE_FAILED", **self._request_data(relative)},
                )
            self._send_bytes(HTTPStatus.INTERNAL_SERVER_ERROR, b"WPS_RESOURCE_READ_FAILED", "text/plain; charset=utf-8", send_body=send_body)
            return

        summary = self.asset_metadata.get(relative, {})
        response_data = {
            **self._request_data(relative),
            "status": int(HTTPStatus.OK),
            "file_size": len(body),
            "file_sha256_prefix": hashlib.sha256(body).hexdigest()[:12],
        }
        if summary and (summary.get("bytes") != len(body) or summary.get("sha256") != hashlib.sha256(body).hexdigest()):
            response_data["stable_error_code"] = "WPS_BUILD_ASSET_CHANGED"
            self._log("ERROR", "wps.resource.asset.changed", "当前构建资源在服务期间发生变化", response_data)
        self._send_bytes(HTTPStatus.OK, body, self._content_type(relative), send_body=send_body)
        if relative == "index.html" and not self._is_internal_probe():
            self._log(
                "INFO",
                "wps.resource.index.served",
                "插件主页面已原样返回",
                {**response_data, "result_cn": "成功"},
            )

    @staticmethod
    def _content_type(relative: str) -> str:
        return CONTENT_TYPES.get(Path(relative).suffix.casefold(), "application/octet-stream")

    def translate_path(self, path: str) -> str:
        relative = unquote(urlsplit(path).path).lstrip("/")
        safe = self._safe_path(relative)
        return str(safe or self.root / "__missing__")

    def _safe_path(self, relative: str) -> Optional[Path]:
        candidate = (self.root / relative).resolve()
        try:
            candidate.relative_to(self.root.resolve())
        except ValueError:
            return None
        return candidate

    def log_message(self, format: str, *args: object) -> None:
        # Access logs can contain request headers or query strings.  The
        # structured events above intentionally keep only safe summaries.
        return


class WpsDebugServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _read_build_metadata(root: Path, build_id: str, project_version: str) -> tuple[str, str]:
    manifest_path = root / "debug-package.json"
    if manifest_path.is_file():
        value = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("WPS_DEBUG_PACKAGE_MANIFEST_INVALID")
        build_id = str(value.get("build_id", build_id))
    package_path = root / "package.json"
    if package_path.is_file():
        value = json.loads(package_path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError("WPS_DEBUG_PACKAGE_PACKAGE_INVALID")
        project_version = str(value.get("version", project_version))
    return build_id, project_version


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--build-id", default="")
    parser.add_argument("--version", default="")
    args = parser.parse_args()
    root = args.root.resolve()
    if not root.is_dir():
        raise SystemExit("WPS_DEBUG_PACKAGE_MISSING: %s" % root)
    build_id, project_version = _read_build_metadata(root, args.build_id, args.version)
    server = WpsDebugServer(("127.0.0.1", args.port), WpsDebugHandler)
    server.root = root  # type: ignore[attr-defined]
    server.build_id = build_id  # type: ignore[attr-defined]
    server.project_version = project_version  # type: ignore[attr-defined]
    server.asset_metadata = asset_summary(root)  # type: ignore[attr-defined]
    server.log_writer = UnifiedLogWriter(args.log.resolve())  # type: ignore[attr-defined]
    server.log_writer.append(
        [
            {
                "timestamp": utc_now(),
                "level": "INFO",
                "component": "debug_server",
                "event": "wps.resource.server.ready",
                "message": "WPS 插件资源服务已启动",
                "build_id": build_id,
                "data": {"root_name": root.name, "port": args.port, "asset_count": len(server.asset_metadata)},
            },
            {
                "timestamp": utc_now(),
                "level": "INFO",
                "component": "debug_server",
                "event": "wps.resource.root.ready",
                "message": "插件资源目录已确认",
                "build_id": build_id,
                "data": {"root_name": root.name, "result_cn": "使用当前构建目录"},
            },
            {
                "timestamp": utc_now(),
                "level": "INFO",
                "component": "debug_server",
                "event": "wps.resource.hot_update.disabled",
                "message": "WPS 主页面未启用动态热更新注入",
                "build_id": build_id,
                "data": {"result_cn": "使用构建原始内容"},
            },
        ]
    )
    print("Docxtool WPS 资源服务已启动：127.0.0.1:%d" % args.port, flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
