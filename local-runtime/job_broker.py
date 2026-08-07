"""Port-free local recognition job broker.

The broker is deliberately a small file-queue companion process.  It never
opens a DOCX and it never accepts an executable path or command line from a
job.  The installed runtime manifest is the only source of the recognizer
path and hash.
"""

from __future__ import annotations

import argparse
import ctypes
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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from wps_logging import UnifiedLogWriter  # noqa: E402


SCHEMA_VERSION = 1
CONTRACT_VERSION = 1
BROKER_VERSION = "1.3.2"
DEFAULT_SCAN_INTERVAL_SECONDS = 0.15
HEARTBEAT_INTERVAL_SECONDS = 1.0
CLAIM_LEASE_SECONDS = 15.0
UUID_V4 = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

BROKER_STARTUP_ERROR_TEXT = {
    "LOCAL_JOB_BROKER_RUNTIME_MISMATCH": ("运行时清单版本或合同不一致", "重新安装本地识别组件后重试"),
    "LOCAL_JOB_BROKER_RECOGNIZER_NOT_ALLOWED": ("运行时清单中的识别程序路径不在受信 runtime 内", "重新安装本地识别组件后重试"),
    "LOCAL_JOB_BROKER_RUNTIME_SHA256_MISMATCH": ("识别程序文件哈希与运行时清单不一致", "重新构建并安装本地识别组件"),
    "LOCAL_JOB_BROKER_IDENTITY_MISMATCH": ("运行时清单中的 Broker 身份字段不一致", "重新构建并安装当前 Broker"),
    "LOCAL_JOB_BROKER_HASH_MISMATCH": ("Broker 文件哈希与运行时清单不一致", "重新构建并安装当前 Broker"),
    "LOCAL_JOB_BROKER_VERSION_MISMATCH": ("Broker 版本与运行时清单不一致", "重新构建并安装当前 Broker"),
}


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


def canonical_path(value: str | Path) -> str:
    return os.path.normcase(os.path.abspath(os.path.normpath(str(value))))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalized_path_hash(path: Path) -> str:
    return text_sha256(str(path.resolve()).replace("/", "\\").casefold())


def process_created_at(pid: int) -> str:
    """Return a process creation timestamp without trusting PID alone."""
    if os.name != "nt":
        return ""
    try:
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        handle = kernel32.OpenProcess(0x1000, False, int(pid))
        if not handle:
            return ""
        creation = wintypes.FILETIME()
        exit_time = wintypes.FILETIME()
        kernel32.GetProcessTimes.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME), ctypes.POINTER(wintypes.FILETIME)]
        try:
            if not kernel32.GetProcessTimes(handle, ctypes.byref(creation), ctypes.byref(exit_time), ctypes.byref(wintypes.FILETIME()), ctypes.byref(wintypes.FILETIME())):
                return ""
        finally:
            kernel32.CloseHandle(handle)
        value = (int(creation.dwHighDateTime) << 32) | int(creation.dwLowDateTime)
        unix_seconds = (value - 116444736000000000) / 10_000_000
        return datetime.fromtimestamp(unix_seconds, timezone.utc).isoformat().replace("+00:00", "Z")
    except (OSError, OverflowError, ValueError, AttributeError):
        return ""


def parse_timestamp(value: object) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def owner_alive(pid: object, expected_created_at: object) -> bool:
    try:
        process_id = int(pid)
    except (TypeError, ValueError):
        return False
    if process_id <= 0:
        return False
    actual_created_at = process_created_at(process_id)
    if os.name == "nt":
        expected = parse_timestamp(expected_created_at)
        actual = parse_timestamp(actual_created_at)
        return expected is not None and actual is not None and abs((actual - expected).total_seconds()) <= 2
    try:
        os.kill(process_id, 0)
        return not expected_created_at or actual_created_at == expected_created_at
    except OSError:
        return False


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
    broker_executable_path: Optional[Path] = None
    log_path: Optional[Path] = None

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
        self.log_writer = UnifiedLogWriter(config.log_path) if config.log_path else None
        self.pid = os.getpid()
        self.started_at = utc_now()
        self.broker_instance_id = str(uuid.uuid4())
        self.process_created_at = process_created_at(self.pid) or self.started_at
        self.executable_path = (config.broker_executable_path or Path(sys.executable)).resolve()
        self.last_job_id = ""
        self.last_error_code = ""
        self.last_error_detail = ""
        self.active_job_id: Optional[str] = None
        self.active_process: Optional[subprocess.Popen] = None
        self.last_heartbeat = 0.0
        self.started = False
        self.startup_stage = "启动本地任务代理"

    def startup(self) -> None:
        if self.started:
            return
        self._log_lifecycle("INFO", "broker.process.started", "本地任务代理进程已启动", "启动本地任务代理")
        self.startup_stage = "读取运行时清单"
        self._log_lifecycle("INFO", "broker.runtime.read.start", "开始读取运行时清单", self.startup_stage)
        self._current_runtime()
        self._log_lifecycle("INFO", "broker.runtime.valid", "运行时清单校验通过", self.startup_stage)
        self.startup_stage = "初始化任务队列"
        self._log_lifecycle("INFO", "broker.queue.init", "开始初始化任务队列", self.startup_stage)
        self.config.jobs_root.mkdir(parents=True, exist_ok=True)
        actual_state = self._write_status("READY")
        if actual_state != "READY":
            raise ValueError(self.last_error_code or "LOCAL_JOB_BROKER_STATUS_WRITE_FAILED")
        self._log_lifecycle("INFO", "broker.status.created", "状态文件已创建", "写入 Broker 状态")
        self._log_lifecycle("INFO", "broker.ready", "本地任务代理已就绪", "完成本地任务代理启动")
        self.started = True

    def log_startup_failure(self, error: BaseException) -> None:
        code = str(error).split(":", 1)[0] or "BROKER_STARTUP_FAILED"
        reason_cn, action_cn = BROKER_STARTUP_ERROR_TEXT.get(code, ("本地任务代理初始化失败", "查看本地任务代理统一日志中的原始错误后重试"))
        self._log_lifecycle(
            "ERROR",
            "broker.start.failed",
            "本地任务代理初始化失败",
            self.startup_stage,
            reason_cn,
            action_cn,
            code,
            f"{type(error).__name__}: {error}",
        )

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
        self.startup()
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
        broker_path_value = current.get("broker_executable_path")
        broker_hash = current.get("broker_sha256")
        broker_path_hash = current.get("broker_executable_path_hash")
        broker_version = current.get("broker_version")
        queue_contract_version = current.get("queue_contract_version", current.get("broker_contract_version"))
        if not all(isinstance(item, str) and item for item in (broker_path_value, broker_hash, broker_path_hash, broker_version)) or queue_contract_version != self.config.contract_version:
            raise ValueError("LOCAL_JOB_BROKER_IDENTITY_MISMATCH")
        broker_path = Path(str(broker_path_value)).resolve()
        if broker_path != self.executable_path or not broker_path.is_file():
            raise ValueError("LOCAL_JOB_BROKER_IDENTITY_MISMATCH")
        if normalized_path_hash(broker_path) != str(broker_path_hash).lower():
            raise ValueError("LOCAL_JOB_BROKER_IDENTITY_MISMATCH")
        if file_sha256(broker_path) != str(broker_hash).lower():
            raise ValueError("LOCAL_JOB_BROKER_HASH_MISMATCH")
        if broker_version != self.config.broker_version:
            raise ValueError("LOCAL_JOB_BROKER_VERSION_MISMATCH")
        return {
            "runtime_version": runtime_version,
            "runtime_sha256": str(runtime_hash).lower(),
            "recognizer_path": executable,
            "broker_version": broker_version,
            "broker_sha256": str(broker_hash).lower(),
            "broker_executable_path_hash": str(broker_path_hash).lower(),
            "queue_contract_version": queue_contract_version,
        }

    def _write_status(self, state: str) -> str:
        actual_state = state
        try:
            runtime = self._current_runtime()
            runtime_version = runtime["runtime_version"]
            runtime_sha256 = runtime["runtime_sha256"]
            broker_version = runtime["broker_version"]
            broker_sha256 = runtime["broker_sha256"]
            broker_path_hash = runtime["broker_executable_path_hash"]
            queue_contract_version = runtime["queue_contract_version"]
        except (OSError, ValueError) as error:
            runtime_version = ""
            runtime_sha256 = ""
            broker_version = self.config.broker_version
            broker_sha256 = ""
            broker_path_hash = normalized_path_hash(self.executable_path)
            queue_contract_version = self.config.contract_version
            self.last_error_code = str(error) or "LOCAL_JOB_BROKER_RUNTIME_MISMATCH"
            if state in {"READY", "RUNNING"}:
                actual_state = "FAILED"
        atomic_write_json(self.config.status_path, {
            "schema_version": SCHEMA_VERSION,
            "state": actual_state,
            "pid": self.pid,
            "broker_instance_id": self.broker_instance_id,
            "process_created_at": self.process_created_at,
            "broker_version": broker_version,
            "broker_executable_path_hash": broker_path_hash,
            "broker_executable_sha256": broker_sha256,
            "contract_version": self.config.contract_version,
            "queue_contract_version": queue_contract_version,
            "runtime_version": runtime_version,
            "runtime_sha256": runtime_sha256,
            "started_at": self.started_at,
            "heartbeat_at": utc_now(),
            "last_job_id": self.last_job_id,
            "last_error_code": self.last_error_code,
        })
        self.last_heartbeat = time.monotonic()
        return actual_state

    def _heartbeat_status(self) -> None:
        if time.monotonic() - self.last_heartbeat >= HEARTBEAT_INTERVAL_SECONDS:
            state = "RUNNING" if self.active_process is not None else "READY"
            self._write_status(state)

    def _claim_payload(self, job_id: str) -> Dict[str, Any]:
        claimed_at = datetime.now(timezone.utc)
        return {
            "schema_version": SCHEMA_VERSION,
            "job_id": job_id,
            "broker_instance_id": self.broker_instance_id,
            "broker_pid": self.pid,
            "broker_process_created_at": self.process_created_at,
            "claimed_at": claimed_at.isoformat().replace("+00:00", "Z"),
            "lease_until": (claimed_at + timedelta(seconds=CLAIM_LEASE_SECONDS)).isoformat().replace("+00:00", "Z"),
        }

    def _try_create_claim_lock(self, job_dir: Path, job_id: str) -> Optional[Dict[str, Any]]:
        lock_path = job_dir / "claim.lock"
        payload = self._claim_payload(job_id)
        try:
            descriptor = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            return payload
        except FileExistsError:
            return None
        except OSError as error:
            raise ValueError("LOCAL_JOB_CLAIM_LOCK_FAILED") from error

    def _release_claim_lock(self, job_dir: Path) -> None:
        try:
            (job_dir / "claim.lock").unlink()
        except FileNotFoundError:
            pass
        except OSError:
            self.last_error_code = "LOCAL_JOB_CLAIM_LOCK_RELEASE_FAILED"

    def _recover_expired_claims(self) -> None:
        try:
            job_dirs = [path for path in self.config.jobs_root.iterdir() if path.is_dir()]
        except OSError:
            return
        now = datetime.now(timezone.utc)
        for job_dir in job_dirs:
            claim_path = job_dir / "claim.lock"
            claimed_path = job_dir / "claimed.json"
            if not claim_path.exists() and not claimed_path.exists():
                continue
            if any((job_dir / name).exists() for name in ("launched.json", "result.json", "error.json", "finished.json")):
                continue
            try:
                owner = read_json(claim_path if claim_path.exists() else claimed_path)
            except (OSError, ValueError):
                continue
            lease_until = parse_timestamp(owner.get("lease_until"))
            if lease_until is None or lease_until > now or owner_alive(owner.get("broker_pid"), owner.get("broker_process_created_at")):
                continue
            job_id = job_dir.name
            recovery = {
                "schema_version": SCHEMA_VERSION,
                "job_id": job_id,
                "previous_broker_instance_id": owner.get("broker_instance_id", ""),
                "previous_broker_pid": owner.get("broker_pid", 0),
                "recovered_at": utc_now(),
                "reason": "CLAIM_LEASE_EXPIRED_AND_OWNER_GONE",
            }
            atomic_write_json(job_dir / "recovery.json", recovery)
            if not (job_dir / "queued.json").exists():
                queue_payload = {key: owner.get(key) for key in ("schema_version", "job_id", "contract_version", "runtime_version", "runtime_sha256", "created_at", "build_id")}
                if all(value is not None for value in queue_payload.values()):
                    atomic_write_json(job_dir / "queued.json", queue_payload)
            try:
                claimed_path.unlink()
            except FileNotFoundError:
                pass
            self._release_claim_lock(job_dir)

    def _claim_oldest_job(self) -> Optional[Path]:
        self._recover_expired_claims()
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
            if any((job_dir / name).exists() for name in ("claimed.json", "launched.json", "result.json", "error.json", "finished.json")):
                continue
            try:
                claim = self._try_create_claim_lock(job_dir, job_id)
            except ValueError as error:
                self._fail_job(job_dir, str(error))
                continue
            if claim is None:
                continue
            try:
                queued_payload = read_json(queued)
                self._validate_queued(job_id, queued_payload)
                request = read_json(job_dir / "request.json")
                self._validate_request(job_id, job_dir, request)
                atomic_write_json(job_dir / "claimed.json", {**queued_payload, **claim})
                queued.unlink()
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
        self.last_error_detail = ""
        if request.get("schema_version") != SCHEMA_VERSION or request.get("request_id") != job_id:
            raise ValueError("LOCAL_JOB_REQUEST_INVALID")
        result_path = request.get("result_path")
        error_path = request.get("error_path")
        if not isinstance(result_path, str) or not isinstance(error_path, str):
            raise ValueError("LOCAL_JOB_REQUEST_PATH_INVALID")
        result_matches = canonical_path(result_path) == canonical_path(job_dir / "result.json")
        error_matches = canonical_path(error_path) == canonical_path(job_dir / "error.json")
        if not result_matches or not error_matches:
            self.last_error_detail = f"result_path_match={str(result_matches).lower()}; error_path_match={str(error_matches).lower()}"
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
            if cancel_path.exists():
                self._finish_cancelled(job_dir, job_id)
                return
            creation_flags = 0
            if sys.platform == "win32":
                creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            process = subprocess.Popen(
                [str(runtime["recognizer_path"]), "--request", str(request_path), "--result", str(result_path), "--error", str(error_path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
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
                "broker_instance_id": self.broker_instance_id,
                "recognizer_pid": process.pid,
                "launched_at": utc_now(),
            })
            self._write_heartbeat(job_dir, "launched", process.pid)
            self._log("识别进程已启动", job_id)
        except Exception as error:  # noqa: BLE001 - launch errors are returned to Worker
            self._fail_job(job_dir, "LOCAL_JOB_RECOGNIZER_START_FAILED", error)

    def _reap_active(self) -> None:
        if self.active_process is None or self.active_job_id is None:
            return
        job_dir = self.config.jobs_root / self.active_job_id
        # The Worker removes a terminal job directory after consuming
        # result.json/error.json.  If the recognizer has not been reaped yet,
        # a missing directory means the terminal result was already consumed;
        # it must not be converted into a synthetic RESULT_MISSING failure or
        # recreated with a heartbeat file.
        if not job_dir.exists():
            if self.active_process.poll() is None:
                return
            self.last_error_code = ""
            self._log("识别结果已由 Worker 消费", self.active_job_id)
            self._close_active()
            return
        cancel_requested = (job_dir / "cancel.json").exists()
        if cancel_requested and self.active_process.poll() is None:
            try:
                self.active_process.terminate()
            except OSError:
                pass
            return
        return_code = self.active_process.poll()
        if return_code is None:
            self._write_heartbeat(job_dir, "running", self.active_process.pid)
            return
        result_exists = (job_dir / "result.json").exists()
        error_exists = (job_dir / "error.json").exists()
        if result_exists:
            self.last_error_code = ""
            atomic_write_json(job_dir / "finished.json", {"schema_version": SCHEMA_VERSION, "job_id": self.active_job_id, "finished_at": utc_now(), "exit_code": return_code, "state": "completed"})
            self._log("识别完成", self.active_job_id)
        elif error_exists:
            atomic_write_json(job_dir / "finished.json", {"schema_version": SCHEMA_VERSION, "job_id": self.active_job_id, "finished_at": utc_now(), "exit_code": return_code, "state": "failed"})
            error_payload = read_json(job_dir / "error.json")
            self._log("识别失败", self.active_job_id, str(error_payload.get("error_code", "LOCAL_RECOGNITION_FAILED")))
        elif cancel_requested:
            self._finish_cancelled(job_dir, self.active_job_id, "CANCELLED_DURING_RECOGNITION")
        else:
            self._fail_job(job_dir, "LOCAL_RECOGNITION_FAILED" if return_code else "LOCAL_RECOGNITION_RESULT_MISSING")
        self._close_active()

    def _write_heartbeat(self, job_dir: Path, state: str, recognizer_pid: Optional[int] = None) -> None:
        atomic_write_json(job_dir / "heartbeat.json", {"schema_version": SCHEMA_VERSION, "job_id": job_dir.name, "broker_pid": self.pid, "recognizer_pid": recognizer_pid, "state": state, "heartbeat_at": utc_now()})

    def _finish_cancelled(self, job_dir: Path, job_id: str, code: str = "CANCELLED_BEFORE_LAUNCH") -> None:
        if (job_dir / "result.json").exists():
            atomic_write_json(job_dir / "finished.json", {"schema_version": SCHEMA_VERSION, "job_id": job_id, "finished_at": utc_now(), "state": "completed"})
            return
        if (job_dir / "error.json").exists():
            atomic_write_json(job_dir / "finished.json", {"schema_version": SCHEMA_VERSION, "job_id": job_id, "finished_at": utc_now(), "state": "failed"})
            return
        atomic_write_json(job_dir / "error.json", {"schema_version": SCHEMA_VERSION, "request_id": job_id, "error_code": code, "error_type": "CancelledError"})
        atomic_write_json(job_dir / "finished.json", {"schema_version": SCHEMA_VERSION, "job_id": job_id, "finished_at": utc_now(), "state": "cancelled"})
        self._log("任务已取消", job_id)

    def _fail_job(self, job_dir: Path, code: str, error: Optional[Exception] = None) -> None:
        job_id = job_dir.name
        self.last_job_id = job_id if safe_job_id(job_id) else ""
        self.last_error_code = code
        try:
            if (job_dir / "result.json").exists():
                atomic_write_json(job_dir / "finished.json", {"schema_version": SCHEMA_VERSION, "job_id": job_id, "finished_at": utc_now(), "state": "completed"})
            elif (job_dir / "error.json").exists():
                atomic_write_json(job_dir / "finished.json", {"schema_version": SCHEMA_VERSION, "job_id": job_id, "finished_at": utc_now(), "state": "failed"})
            else:
                payload = {"schema_version": SCHEMA_VERSION, "request_id": job_id, "error_code": code, "error_type": type(error).__name__ if error else "BrokerError", **({"technical_detail": self.last_error_detail} if self.last_error_detail else {})}
                atomic_write_json(job_dir / "error.json", payload)
                atomic_write_json(job_dir / "finished.json", {"schema_version": SCHEMA_VERSION, "job_id": job_id, "finished_at": utc_now(), "state": "failed"})
        except OSError:
            pass
        self._release_claim_lock(job_dir)
        self._log("任务失败", job_id, code, self.last_error_detail)

    def _stop_active(self) -> None:
        if self.active_process is not None and self.active_process.poll() is None:
            try:
                self.active_process.terminate()
            except OSError:
                pass
        self._close_active()

    def _close_active(self) -> None:
        self.active_process = None
        self.active_job_id = None

    def _log_lifecycle(
        self,
        level: str,
        event: str,
        message: str,
        stage_cn: str,
        reason_cn: str = "",
        action_cn: str = "",
        error_code: str = "",
        technical_detail: str = "",
    ) -> None:
        if self.log_writer is None:
            return
        data: Dict[str, object] = {"stage_cn": stage_cn}
        if reason_cn:
            data["reason_cn"] = reason_cn
        if action_cn:
            data["action_cn"] = action_cn
        if error_code:
            data["stable_error_code"] = error_code
        if technical_detail:
            data["technical_detail"] = technical_detail
        self.log_writer.append([{
            "timestamp": utc_now(),
            "level": level,
            "component": "broker",
            "event": event,
            "message": message,
            "data": data,
        }])

    def _log(self, message: str, job_id: str, code: str = "", technical_detail: str = "") -> None:
        if self.log_writer is None:
            return
        event_codes = {
            "任务已领取": "broker.job.claimed",
            "识别进程已启动": "broker.recognizer.started",
            "识别结果已由 Worker 消费": "broker.result.consumed",
            "识别完成": "broker.recognizer.completed",
            "识别失败": "broker.recognizer.failed",
            "任务已取消": "broker.job.cancelled",
            "任务失败": "broker.job.failed",
        }
        self.log_writer.append([{
            "timestamp": utc_now(),
            "level": "ERROR" if code else "INFO",
            "component": "broker",
            "event": event_codes.get(message, "broker.event"),
            "message": message,
            "data": {"request_id": job_id[:8], "stable_error_code": code, **({"technical_detail": technical_detail} if technical_detail else {})},
        }])


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
    parser.add_argument("--log-path", default="", help="统一中文运行日志路径")
    args = parser.parse_args(argv)
    root = Path(args.root) if args.root else appdata_root(None)
    config = BrokerConfig(appdata_root=root, scan_interval_seconds=max(0.1, min(0.25, args.scan_interval)), log_path=Path(args.log_path) if args.log_path else None)
    broker = JobBroker(config)
    try:
        broker.startup()
    except (OSError, ValueError) as error:
        broker.log_startup_failure(error)
        return 1
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
