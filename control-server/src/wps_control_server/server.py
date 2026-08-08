"""Loopback-only HTTP control server and endpoint manifest lifecycle."""

from __future__ import annotations

import hmac
import json
import os
import secrets
import socket
import threading
import uuid
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlsplit

from .contracts import CONTROL_CONTRACT_VERSION, SERVER_VERSION, ContractError, validate_job_request
from .adapters import default_formatting_planner
from .document_repair import DocumentRepairError, DocumentRepairManager
from .jobs import JobCoordinator, JobStore, utc_now
from .ports import FormattingPlannerPort, RecognitionPort, UnavailableRecognitionPort

WPS_RESOURCE_ORIGIN = "http://127.0.0.1:3889"


def default_manifest_path() -> Path:
    root = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    if root:
        return Path(root) / "DocxToolWps" / "control" / "endpoint.json"
    return Path.home() / ".docxtool-wps" / "control" / "endpoint.json"


def atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, indent=2))
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    os.replace(str(temporary), str(path))


def _loopback_host(value: str) -> bool:
    try:
        host = urlsplit("//" + value).hostname or ""
    except ValueError:
        return False
    return host in ("127.0.0.1", "localhost", "::1")


def _random_server_port() -> int:
    for _ in range(20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = int(probe.getsockname()[1])
        if port != 9528 and port >= 1024:
            return port
    raise OSError("CONTROL_SERVER_PORT_UNAVAILABLE")


@dataclass(frozen=True)
class ControlServerConfig:
    host: str = "127.0.0.1"
    port: int = 0
    manifest_path: Path = default_manifest_path()
    server_version: str = SERVER_VERSION
    contract_version: int = CONTROL_CONTRACT_VERSION
    max_body_bytes: int = 8 * 1024 * 1024
    stage_timeout_seconds: float = 120.0
    heartbeat_interval_seconds: float = 1.0

    def __post_init__(self) -> None:
        if self.host != "127.0.0.1":
            raise ValueError("CONTROL_SERVER_MUST_BIND_LOOPBACK")
        if self.port == 9528 or self.port < 0 or self.port > 65535:
            raise ValueError("CONTROL_SERVER_PORT_INVALID")


class _RequestHandler(BaseHTTPRequestHandler):
    server_version = "WPSControlServer/1"
    protocol_version = "HTTP/1.1"

    @property
    def control(self) -> "ControlServer":
        return self.server.control  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        # Access logs can accidentally contain paths or authorization values;
        # the control server intentionally emits no request-body logs.
        return

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if self.headers.get("Origin") == WPS_RESOURCE_ORIGIN:
            self.send_header("Access-Control-Allow-Origin", WPS_RESOURCE_ORIGIN)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, code: str, details: Optional[Dict[str, object]] = None) -> None:
        self._send(status, {"error": {"code": code, "message": code, **({"details": details} if details else {})}})

    def _authorized(self) -> bool:
        origin = self.headers.get("Origin")
        if origin and origin != WPS_RESOURCE_ORIGIN:
            self._error(HTTPStatus.FORBIDDEN, "CONTROL_SERVER_ORIGIN_FORBIDDEN")
            return False
        host = self.headers.get("Host", "")
        if not _loopback_host(host):
            self._error(HTTPStatus.FORBIDDEN, "CONTROL_SERVER_NON_LOOPBACK_HOST")
            return False
        header = self.headers.get("Authorization", "")
        prefix = "Bearer "
        if not header.startswith(prefix) or not hmac.compare_digest(header[len(prefix):], self.control.session_token):
            self._error(HTTPStatus.UNAUTHORIZED, "CONTROL_SERVER_UNAUTHORIZED")
            return False
        return True

    def do_OPTIONS(self) -> None:  # noqa: N802
        origin = self.headers.get("Origin", "")
        requested_method = self.headers.get("Access-Control-Request-Method", "").upper()
        requested_headers = {
            value.strip().casefold()
            for value in self.headers.get("Access-Control-Request-Headers", "").split(",")
            if value.strip()
        }
        if origin != WPS_RESOURCE_ORIGIN or requested_method not in ("GET", "POST") or not requested_headers.issubset({"authorization", "content-type"}):
            self._error(HTTPStatus.FORBIDDEN, "CONTROL_SERVER_CORS_PREFLIGHT_REJECTED")
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", WPS_RESOURCE_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def _read_json(self) -> Optional[Dict[str, Any]]:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().casefold()
        if content_type != "application/json":
            self._error(HTTPStatus.BAD_REQUEST, "CONTROL_SERVER_CONTENT_TYPE_INVALID")
            return None
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0 or length > self.control.config.max_body_bytes:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "CONTROL_SERVER_REQUEST_TOO_LARGE")
            return None
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(HTTPStatus.BAD_REQUEST, "CONTROL_SERVER_INVALID_JSON")
            return None
        if not isinstance(value, dict):
            self._error(HTTPStatus.BAD_REQUEST, "CONTROL_SERVER_REQUEST_INVALID")
            return None
        return value

    def do_GET(self) -> None:  # noqa: N802
        if not self._authorized():
            return
        path = urlsplit(self.path).path
        if path == "/v1/health":
            self._send(HTTPStatus.OK, self.control.health())
            return
        if path == "/v1/capabilities":
            self._send(HTTPStatus.OK, self.control.capabilities())
            return
        job_id = self.control.job_path(path, "/result")
        if job_id:
            value = self.control.result(job_id)
            if value is None:
                self._error(HTTPStatus.NOT_FOUND, "CONTROL_SERVER_JOB_NOT_FOUND")
            elif value.get("error_code"):
                self._error(HTTPStatus.CONFLICT, str(value["error_code"]))
            else:
                self._send(HTTPStatus.OK, value["result"])
            return
        job_id = self.control.job_path(path, "")
        if job_id:
            value = self.control.status(job_id)
            if value is None:
                self._error(HTTPStatus.NOT_FOUND, "CONTROL_SERVER_JOB_NOT_FOUND")
            else:
                self._send(HTTPStatus.OK, value)
            return
        self._error(HTTPStatus.NOT_FOUND, "CONTROL_SERVER_ROUTE_NOT_FOUND")

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            return
        path = urlsplit(self.path).path
        if path == "/v1/document-repairs/inspect":
            payload = self._read_json()
            if payload is None:
                return
            if set(payload) != {"schema_version", "source_path", "document_identity"} or payload.get("schema_version") != 1 or not isinstance(payload.get("source_path"), str) or not isinstance(payload.get("document_identity"), str):
                self._error(HTTPStatus.BAD_REQUEST, "CONTROL_SERVER_REQUEST_INVALID")
                return
            try:
                self._send(HTTPStatus.OK, self.control.document_repairs.inspect(payload["source_path"]))
            except DocumentRepairError as exc:
                self._error(HTTPStatus.CONFLICT, exc.code, exc.details)
            return
        repair_action = self.control.document_repair_path(path)
        if repair_action:
            repair_id, action = repair_action
            payload = self._read_json()
            if payload is None:
                return
            try:
                if action == "apply" and payload == {"schema_version": 1}:
                    self._send(HTTPStatus.OK, self.control.document_repairs.apply(repair_id))
                    return
                if action == "complete" and set(payload) == {"schema_version", "outcome"} and payload.get("schema_version") == 1 and payload.get("outcome") in ("commit", "restore"):
                    self._send(HTTPStatus.OK, self.control.document_repairs.complete(repair_id, str(payload["outcome"])))
                    return
                self._error(HTTPStatus.BAD_REQUEST, "CONTROL_SERVER_REQUEST_INVALID")
            except DocumentRepairError as exc:
                self._error(HTTPStatus.CONFLICT, exc.code, exc.details)
            return
        if path == "/v1/jobs":
            payload = self._read_json()
            if payload is None:
                return
            try:
                request = validate_job_request(payload, self.control.config.max_body_bytes)
                job, duplicate = self.control.submit(request)
            except ContractError as exc:
                status = HTTPStatus.CONFLICT if exc.code in ("CONTROL_SERVER_JOB_REJECTED", "CONTROL_SERVER_REQUEST_ID_REUSE") else HTTPStatus.BAD_REQUEST
                self._error(status, exc.code)
                return
            self._send(HTTPStatus.ACCEPTED, {"job_id": job.job_id, "request_id": request["request_id"], "status": job.status, "idempotent": duplicate})
            return
        job_id = self.control.job_path(path, "/cancel")
        if job_id:
            if self.headers.get("Content-Length", "0") not in ("", "0"):
                payload = self._read_json()
                if payload is None:
                    return
                if payload:
                    self._error(HTTPStatus.BAD_REQUEST, "CONTROL_SERVER_CANCEL_BODY_INVALID")
                    return
            value = self.control.cancel(job_id)
            if value is None:
                self._error(HTTPStatus.NOT_FOUND, "CONTROL_SERVER_JOB_NOT_FOUND")
            else:
                self._send(HTTPStatus.ACCEPTED, value)
            return
        self._error(HTTPStatus.NOT_FOUND, "CONTROL_SERVER_ROUTE_NOT_FOUND")


class _Server(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True

    def __init__(self, address: Tuple[str, int], control: "ControlServer") -> None:
        self.control = control
        super().__init__(address, _RequestHandler)


class ControlServer:
    def __init__(
        self,
        config: ControlServerConfig,
        recognition: Optional[RecognitionPort] = None,
        planner: Optional[FormattingPlannerPort] = None,
    ) -> None:
        self.config = config
        self.session_token = secrets.token_urlsafe(32)
        self.instance_id = str(uuid.uuid4())
        self.started_at = utc_now()
        self.process_created_at = self.started_at
        self._server: Optional[_Server] = None
        self._serve_thread: Optional[threading.Thread] = None
        self._heartbeat_stop = threading.Event()
        self._heartbeat_thread: Optional[threading.Thread] = None
        self.store = JobStore()
        self.document_repairs = DocumentRepairManager()
        self.coordinator = JobCoordinator(
            self.store,
            recognition or UnavailableRecognitionPort(),
            planner or default_formatting_planner(),
            config.stage_timeout_seconds,
        )

    @property
    def port(self) -> int:
        if self._server is None:
            return 0
        return int(self._server.server_address[1])

    @property
    def manifest(self) -> Dict[str, Any]:
        return {
            "schema_version": 1,
            "instance_id": self.instance_id,
            "pid": os.getpid(),
            "process_created_at": self.process_created_at,
            "host": "127.0.0.1",
            "port": self.port,
            "base_url": "http://127.0.0.1:%d" % self.port,
            "session_token": self.session_token,
            "server_version": self.config.server_version,
            "contract_version": self.config.contract_version,
            "started_at": self.started_at,
            "heartbeat_at": utc_now(),
        }

    def start(self) -> "ControlServer":
        if self._server is not None:
            return self
        requested_port = self.config.port or _random_server_port()
        self._server = _Server((self.config.host, requested_port), self)
        if self.port == 9528:
            self._server.server_close()
            self._server = None
            raise OSError("CONTROL_SERVER_FIXED_PORT_FORBIDDEN")
        atomic_write_json(self.config.manifest_path, self.manifest)
        self.coordinator.start()
        self._heartbeat_stop.clear()
        self._heartbeat_thread = threading.Thread(target=self._heartbeat_loop, name="wps-control-heartbeat", daemon=True)
        self._heartbeat_thread.start()
        self._serve_thread = threading.Thread(target=self._server.serve_forever, name="wps-control-http", daemon=True)
        self._serve_thread.start()
        return self

    def wait(self) -> None:
        if self._serve_thread:
            self._serve_thread.join()

    def close(self) -> None:
        self._heartbeat_stop.set()
        self.coordinator.stop()
        if self._server:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
        if self._heartbeat_thread:
            self._heartbeat_thread.join(timeout=2.0)
        try:
            existing = json.loads(self.config.manifest_path.read_text(encoding="utf-8"))
            if isinstance(existing, dict) and existing.get("instance_id") == self.instance_id:
                self.config.manifest_path.unlink(missing_ok=True)
        except (OSError, ValueError):
            pass

    def _heartbeat_loop(self) -> None:
        while not self._heartbeat_stop.wait(self.config.heartbeat_interval_seconds):
            try:
                atomic_write_json(self.config.manifest_path, self.manifest)
            except OSError:
                pass

    def health(self) -> Dict[str, Any]:
        return {
            "status": "ready",
            "server_version": self.config.server_version,
            "contract_version": self.config.contract_version,
            "instance_id": self.instance_id,
            "pid": os.getpid(),
            "process_created_at": self.process_created_at,
            "heartbeat_at": utc_now(),
            "jobs": self.store.counts(),
        }

    def capabilities(self) -> Dict[str, Any]:
        return {
            "schema_version": self.config.contract_version,
            "server_version": self.config.server_version,
            "recognition": {"available": bool(getattr(self.coordinator.recognition, "available", True)), "contract_versions": [1], "max_paragraphs": 5000},
            "formatting": {"available": bool(getattr(self.coordinator.planner, "available", True)), "plan_versions": [1]},
            "job": {"cancel": True, "max_active_jobs": 1, "max_queued_jobs": 1},
        }

    def submit(self, request: Dict[str, Any]):
        return self.store.submit(request)

    def status(self, job_id: str) -> Optional[Dict[str, Any]]:
        job = self.store.status(job_id)
        return job.public_status() if job else None

    def result(self, job_id: str) -> Optional[Dict[str, Any]]:
        job = self.store.status(job_id)
        if not job:
            return None
        if job.status == "completed" and job.result is not None:
            return {"result": job.result}
        if job.status == "failed" and job.error:
            return {"error_code": job.error["code"]}
        if job.status == "cancelled":
            return {"error_code": "PIPELINE_CANCELLED"}
        return {"error_code": "CONTROL_SERVER_RESULT_NOT_READY"}

    def cancel(self, job_id: str) -> Optional[Dict[str, Any]]:
        job = self.store.cancel(job_id)
        return job.public_status() if job else None

    @staticmethod
    def job_path(path: str, suffix: str) -> Optional[str]:
        prefix = "/v1/jobs/"
        if not path.startswith(prefix) or suffix and not path.endswith(suffix):
            return None
        value = path[len(prefix):]
        if suffix:
            value = value[: -len(suffix)]
        if not value or "/" in value:
            return None
        try:
            uuid.UUID(value)
        except ValueError:
            return None
        return value

    @staticmethod
    def document_repair_path(path: str) -> Optional[Tuple[str, str]]:
        prefix = "/v1/document-repairs/"
        if not path.startswith(prefix):
            return None
        values = path[len(prefix):].split("/")
        if len(values) != 2 or values[1] not in ("apply", "complete"):
            return None
        try:
            uuid.UUID(values[0])
        except ValueError:
            return None
        return values[0], values[1]


def create_server(
    manifest_path: Optional[Path] = None,
    port: int = 0,
    recognition: Optional[RecognitionPort] = None,
    planner: Optional[FormattingPlannerPort] = None,
) -> ControlServer:
    return ControlServer(
        ControlServerConfig(port=port, manifest_path=manifest_path or default_manifest_path()),
        recognition,
        planner,
    )
