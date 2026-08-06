"""Port-free local recognition job broker.

The broker is deliberately a small file-queue companion process.  It never
opens a DOCX and it never accepts an executable path or command line from a
job.  The installed runtime manifest is the only source of the recognizer
path and hash.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


SCHEMA_VERSION = 1
CONTRACT_VERSION = 1
BROKER_VERSION = "1.0"
DEFAULT_SCAN_INTERVAL_SECONDS = 0.15
HEARTBEAT_INTERVAL_SECONDS = 1.0
UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    with temp.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(str(temp), str(path))


def read_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("INVALID_JSON_OBJECT")
    return value


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_job_id(value: object) -> bool:
    return isinstance(value, str) and bool(UUID_V4.fullmatch(value)) and uuid.UUID(value).version == 4


def is_within(path: Path, parent: Path) -> bool:
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


@dataclass(frozen=True)
class BrokerConfig:
    appdata_root: Path
    scan_interval_seconds: float = DEFAULT_SCAN_INTERVAL_SECONDS
    broker_version: str = BROKER_VERSION
    contract_version: int = CONTRACT_VERSION

    @property
    def jobs_root(self) -> Path:
        return self.appdata_root / "jobs"

    @property
    def broker_root(self) -> Path:
        return self.appdata_root / "broker"

    @property
    def status_path(self) -> Path:
        return self.broker_root / "status.json"

    @property
    def runtime_current_path(self) -> Path:
        return self.appdata_root / "runtime" / "current.json"


class JobBroker:
    def __init__(self, config: BrokerConfig) -> None:
        self.config = config
        self.pid = os.getpid()
        self.started_at = utc_now()
        self.last_job_id = ""
        self.last_error_code = ""
        self.active_job_id: Optional[str] = None
        self.active_process: Optional[subprocess.Popen] = None
        self.active_log = None
        self.last_heartbeat = 0.0

    def run_once(self) -> bool:
        self._write_status("READY")
        self._reap_active()
        if self.active_process is not None:
            self._heartbeat_status()
            return False
        job = self._claim_oldest_job()
        if job is None:
            self._heartbeat_status()
            return False
        self._launch_job(job)
        self._heartbeat_status()
        return True

    def run_forever(self, stop_event: threading.Event) -> int:
        self._write_status("READY")
        try:
            while not stop_event.is_set():
                self.run_once()
                stop_event.wait(self.config.scan_interval_seconds)
        finally:
            self._stop_active()
            self._write_status("STOPPED")
        return 0

    def _current_runtime(self) -> Dict[str, Any]:
        current = read_json(self.config.runtime_current_path)
        if current.get("schema_version") != SCHEMA_VERSION or current.get("contract_version") != CONTRACT_VERSION:
            raise ValueError("LOCAL_JOB_BROKER_RUNTIME_MISMATCH")
        runtime_version = current.get("runtime_version")
        runtime_hash = current.get("executable_sha256")
        executable_value = current.get("executable_path")
        if not all(isinstance(item, str) and item for item in (runtime_version, runtime_hash, executable_value)):
            raise ValueError("LOCAL_JOB_BROKER_RUNTIME_MISMATCH")
        executable = Path(executable_value).resolve()
        runtime_root = (self.config.appdata_root / "runtime").resolve()
        if not is_within(executable, runtime_root) or not executable.is_file():
            raise ValueError("LOCAL_JOB_BROKER_RECOGNIZER_NOT_ALLOWED")
        if file_sha256(executable) != str(runtime_hash).lower():
            raise ValueError("LOCAL_JOB_BROKER_RUNTIME_SHA256_MISMATCH")
        return {"runtime_version": runtime_version, "runtime_sha256": str(runtime_hash).lower(), "recognizer_path": executable}

    def _write_status(self, state: str) -> None:
        try:
            runtime = self._current_runtime()
            runtime_version = runtime["runtime_version"]
            runtime_sha256 = runtime["runtime_sha256"]
        except Exception as error:  # noqa: BLE001 - status must remain diagnosable
            runtime_version = ""
            runtime_sha256 = ""
            self.last_error_code = str(error) or "LOCAL_JOB_BROKER_RUNTIME_MISMATCH"
        atomic_write_json(self.config.status_path, {
            "schema_version": SCHEMA_VERSION,
            "state": state,
            "pid": self.pid,
            "broker_version": self.config.broker_version,
            "contract_version": self.config.contract_version,
            "runtime_version": runtime_version,
            "runtime_sha256": runtime_sha256,
            "started_at": self.started_at,
            "heartbeat_at": utc_now(),
            "last_job_id": self.last_job_id,
            "last_error_code": self.last_error_code,
        })
        self.last_heartbeat = time.monotonic()

    def _heartbeat_status(self) -> None:
        if time.monotonic() - self.last_heartbeat >= HEARTBEAT_INTERVAL_SECONDS:
            state = "RUNNING" if self.active_process is not None else "READY"
            self._write_status(state)

    def _claim_oldest_job(self) -> Optional[Path]:
        try:
            candidates = sorted(self.config.jobs_root.glob("*/queued.json"), key=lambda path: path.stat().st_mtime)
        except OSError:
            return None
        for queued in candidates:
            job_dir = queued.parent
            job_id = job_dir.name
            if not safe_job_id(job_id):
                self._fail_job(job_dir, "LOCAL_JOB_INVALID_ID")
                continue
            claimed = job_dir / "claimed.json"
            try:
                os.replace(str(queued), str(claimed))
            except (FileNotFoundError, PermissionError, OSError):
                continue
            try:
                queued_payload = read_json(claimed)
                self._validate_queued(job_id, queued_payload)
                request = read_json(job_dir / "request.json")
                self._validate_request(job_id, job_dir, request)
                atomic_write_json(claimed, {
                    "schema_version": SCHEMA_VERSION,
                    "job_id": job_id,
                    "broker_pid": self.pid,
                    "broker_version": self.config.broker_version,
                    "claimed_at": utc_now(),
                })
                self.last_job_id = job_id
                self._log("任务已领取", job_id)
                return job_dir
            except Exception as error:  # noqa: BLE001 - job errors become stable files
                self._fail_job(job_dir, str(error) or "LOCAL_JOB_QUEUE_INVALID")
        return None

    def _validate_queued(self, job_id: str, payload: Dict[str, Any]) -> None:
        runtime = self._current_runtime()
        required = {"schema_version", "job_id", "contract_version", "runtime_version", "runtime_sha256", "created_at", "build_id"}
        if set(payload) != required or payload.get("schema_version") != SCHEMA_VERSION or payload.get("contract_version") != self.config.contract_version or payload.get("job_id") != job_id:
            raise ValueError("LOCAL_JOB_QUEUE_INVALID")
        if payload.get("runtime_version") != runtime["runtime_version"] or payload.get("runtime_sha256") != runtime["runtime_sha256"]:
            raise ValueError("LOCAL_JOB_BROKER_RUNTIME_MISMATCH")

    def _validate_request(self, job_id: str, job_dir: Path, request: Dict[str, Any]) -> None:
        if request.get("schema_version") != SCHEMA_VERSION or request.get("request_id") != job_id:
            raise ValueError("LOCAL_JOB_REQUEST_INVALID")
        if request.get("result_path") != str(job_dir / "result.json") or request.get("error_path") != str(job_dir / "error.json"):
            raise ValueError("LOCAL_JOB_REQUEST_PATH_INVALID")
        if not isinstance(request.get("source_path"), str) or not request["source_path"]:
            raise ValueError("LOCAL_JOB_REQUEST_INVALID")
        if not isinstance(request.get("host_snapshot"), dict):
            raise ValueError("LOCAL_JOB_REQUEST_INVALID")

    def _launch_job(self, job_dir: Path) -> None:
        job_id = job_dir.name
        request_path = job_dir / "request.json"
        result_path = job_dir / "result.json"
        error_path = job_dir / "error.json"
        cancel_path = job_dir / "cancel.json"
        if cancel_path.exists():
            self._finish_cancelled(job_dir, job_id)
            return
        try:
            runtime = self._current_runtime()
            log_path = self.config.broker_root / "jobs" / f"{job_id}.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            self.active_log = log_path.open("ab")
            creation_flags = 0
            if sys.platform == "win32":
                creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            process = subprocess.Popen(
                [str(runtime["recognizer_path"]), "--request", str(request_path), "--result", str(result_path), "--error", str(error_path)],
                stdin=subprocess.DEVNULL,
                stdout=self.active_log,
                stderr=subprocess.STDOUT,
                shell=False,
                creationflags=creation_flags,
                close_fds=True,
            )
            self.active_process = process
            self.active_job_id = job_id
            atomic_write_json(job_dir / "launched.json", {
                "schema_version": SCHEMA_VERSION,
                "job_id": job_id,
                "broker_pid": self.pid,
                "recognizer_pid": process.pid,
                "launched_at": utc_now(),
            })
            self._write_heartbeat(job_dir, "running", process.pid)
            self._log("识别进程已启动", job_id)
        except Exception as error:  # noqa: BLE001 - launch errors are returned to Worker
            self._fail_job(job_dir, "LOCAL_JOB_RECOGNIZER_START_FAILED", error)

    def _reap_active(self) -> None:
        if self.active_process is None or self.active_job_id is None:
            return
        job_dir = self.config.jobs_root / self.active_job_id
        if (job_dir / "cancel.json").exists():
            self._stop_active()
            if not (job_dir / "result.json").exists() and not (job_dir / "error.json").exists():
                self._finish_cancelled(job_dir, self.active_job_id)
            return
        return_code = self.active_process.poll()
        if return_code is None:
            self._write_heartbeat(job_dir, "running", self.active_process.pid)
            return
        if not (job_dir / "result.json").exists() and not (job_dir / "error.json").exists():
            self._fail_job(job_dir, "LOCAL_RECOGNITION_FAILED" if return_code else "LOCAL_RECOGNITION_RESULT_MISSING")
        else:
            atomic_write_json(job_dir / "finished.json", {"schema_version": SCHEMA_VERSION, "job_id": self.active_job_id, "finished_at": utc_now(), "exit_code": return_code})
            self._log("识别完成", self.active_job_id)
        self._close_active()

    def _write_heartbeat(self, job_dir: Path, state: str, recognizer_pid: Optional[int] = None) -> None:
        atomic_write_json(job_dir / "heartbeat.json", {"schema_version": SCHEMA_VERSION, "job_id": job_dir.name, "broker_pid": self.pid, "recognizer_pid": recognizer_pid, "state": state, "heartbeat_at": utc_now()})

    def _finish_cancelled(self, job_dir: Path, job_id: str) -> None:
        atomic_write_json(job_dir / "error.json", {"schema_version": SCHEMA_VERSION, "request_id": job_id, "error_code": "RECOGNITION_CANCELLED", "error_type": "CancelledError"})
        atomic_write_json(job_dir / "finished.json", {"schema_version": SCHEMA_VERSION, "job_id": job_id, "finished_at": utc_now(), "state": "cancelled"})
        self._log("任务已取消", job_id)

    def _fail_job(self, job_dir: Path, code: str, error: Optional[Exception] = None) -> None:
        job_id = job_dir.name
        self.last_job_id = job_id if safe_job_id(job_id) else ""
        self.last_error_code = code
        payload = {"schema_version": SCHEMA_VERSION, "request_id": job_id, "error_code": code, "error_type": type(error).__name__ if error else "BrokerError"}
        try:
            atomic_write_json(job_dir / "error.json", payload)
            atomic_write_json(job_dir / "finished.json", {"schema_version": SCHEMA_VERSION, "job_id": job_id, "finished_at": utc_now(), "state": "failed"})
        except OSError:
            pass
        self._log("任务失败", job_id, code)

    def _stop_active(self) -> None:
        if self.active_process is not None and self.active_process.poll() is None:
            try:
                self.active_process.terminate()
            except OSError:
                pass
        self._close_active()

    def _close_active(self) -> None:
        if self.active_log is not None:
            try:
                self.active_log.close()
            except OSError:
                pass
        self.active_log = None
        self.active_process = None
        self.active_job_id = None

    def _log(self, message: str, job_id: str, code: str = "") -> None:
        # The log intentionally contains no source text or complete paths.
        line = f"{utc_now()} [BROKER] {message} job={job_id[:8]}" + (f" code={code}" if code else "") + "\n"
        log_path = self.config.broker_root / "broker.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(line)


def appdata_root(value: Optional[str]) -> Path:
    root = value or os.environ.get("APPDATA")
    if not root:
        raise SystemExit("APPDATA_UNAVAILABLE")
    return Path(root) / "Docxtool"


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="docxtool-job-broker", description="Port-free Docxtool local recognition job broker")
    parser.add_argument("action", nargs="?", choices=("run", "once"), default="run")
    parser.add_argument("--root", help="AppData Docxtool root, used by tests and diagnostics")
    parser.add_argument("--scan-interval", type=float, default=DEFAULT_SCAN_INTERVAL_SECONDS)
    args = parser.parse_args(argv)
    root = Path(args.root) if args.root else appdata_root(None)
    config = BrokerConfig(appdata_root=root, scan_interval_seconds=max(0.1, min(0.25, args.scan_interval)))
    broker = JobBroker(config)
    if args.action == "once":
        broker.run_once()
        broker._write_status("STOPPED")
        return 0
    stop_event = threading.Event()
    for signum in (getattr(signal, "SIGTERM", None), getattr(signal, "SIGINT", None)):
        if signum is not None:
            signal.signal(signum, lambda _signum, _frame: stop_event.set())
    return broker.run_forever(stop_event)


if __name__ == "__main__":
    raise SystemExit(main())
