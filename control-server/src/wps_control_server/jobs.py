"""Bounded job storage and background coordination."""

from __future__ import annotations

import copy
import inspect
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from .contracts import ContractError, canonical_json, validate_result
from .ports import CancellationToken, FormattingPlannerPort, RecognitionPort


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class JobRecord:
    job_id: str
    request: Dict[str, Any]
    status: str = "queued"
    stage: str = "queued"
    created_at: str = field(default_factory=utc_now)
    created_monotonic: float = field(default_factory=time.monotonic, repr=False)
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    error: Optional[Dict[str, str]] = None
    result: Optional[Dict[str, Any]] = None
    metrics: Dict[str, float] = field(default_factory=dict)
    cancellation: CancellationToken = field(default_factory=CancellationToken, repr=False)

    def public_status(self) -> Dict[str, Any]:
        value: Dict[str, Any] = {
            "schema_version": 1,
            "job_id": self.job_id,
            "request_id": self.request["request_id"],
            "status": self.status,
            "stage": self.stage,
            "created_at": self.created_at,
            "metrics": dict(self.metrics),
        }
        if self.started_at:
            value["started_at"] = self.started_at
        if self.finished_at:
            value["finished_at"] = self.finished_at
        if self.error:
            value["error"] = dict(self.error)
        return value


class JobStore:
    """One active job plus one queued job, with request-id idempotency."""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._jobs: Dict[str, JobRecord] = {}
        self._request_index: Dict[str, str] = {}
        self._queue: List[str] = []
        self._active: Optional[str] = None
        self._closed = False

    def submit(self, request: Dict[str, Any]) -> Tuple[JobRecord, bool]:
        request_id = request["request_id"]
        fingerprint = canonical_json(request)
        with self._condition:
            existing_id = self._request_index.get(request_id)
            if existing_id:
                existing = self._jobs[existing_id]
                if canonical_json(existing.request) != fingerprint:
                    raise ContractError("CONTROL_SERVER_REQUEST_ID_REUSE")
                return existing, True
            if self._closed:
                raise ContractError("CONTROL_SERVER_NOT_RUNNING")
            if len(self._queue) >= 1:
                raise ContractError("CONTROL_SERVER_JOB_REJECTED")
            job = JobRecord(job_id=str(uuid.uuid4()), request=copy.deepcopy(request))
            self._jobs[job.job_id] = job
            self._request_index[request_id] = job.job_id
            self._queue.append(job.job_id)
            self._condition.notify_all()
            return job, False

    def take_next(self, timeout: float = 0.5) -> Optional[JobRecord]:
        with self._condition:
            end = time.monotonic() + timeout
            while not self._queue and not self._closed:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    return None
                self._condition.wait(remaining)
            if self._closed or not self._queue:
                return None
            job_id = self._queue.pop(0)
            self._active = job_id
            job = self._jobs[job_id]
            if job.status == "cancelled":
                self._active = None
                return None
            return job

    def status(self, job_id: str) -> Optional[JobRecord]:
        with self._condition:
            return self._jobs.get(job_id)

    def cancel(self, job_id: str) -> Optional[JobRecord]:
        with self._condition:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job.status in ("completed", "failed", "cancelled"):
                return job
            job.cancellation.cancel()
            if job.status == "queued":
                self._queue = [item for item in self._queue if item != job_id]
                job.status = "cancelled"
                job.stage = "cancelled"
                job.finished_at = utc_now()
            self._condition.notify_all()
            return job

    def set_running(self, job: JobRecord, stage: str) -> bool:
        with self._condition:
            if job.cancellation.cancelled or job.status == "cancelled":
                return False
            job.status = stage
            job.stage = stage
            if job.started_at is None:
                job.started_at = utc_now()
                job.metrics["queue_ms"] = (time.monotonic() - job.created_monotonic) * 1000
            return True

    def finish(self, job: JobRecord, result: Optional[Dict[str, Any]], error_code: Optional[str] = None) -> None:
        with self._condition:
            if job.cancellation.cancelled or error_code == "PIPELINE_CANCELLED":
                job.status = "cancelled"
                job.stage = "cancelled"
            elif error_code:
                job.status = "failed"
                job.stage = "failed"
                job.error = {"code": error_code, "message": error_code}
            else:
                job.status = "completed"
                job.stage = "completed"
                job.result = result
            job.finished_at = utc_now()
            if self._active == job.job_id:
                self._active = None
            self._condition.notify_all()

    def close(self) -> None:
        with self._condition:
            self._closed = True
            for job_id in list(self._queue):
                job = self._jobs[job_id]
                job.cancellation.cancel()
                job.status = "cancelled"
                job.stage = "cancelled"
                job.finished_at = utc_now()
            self._queue.clear()
            if self._active and self._active in self._jobs:
                self._jobs[self._active].cancellation.cancel()
            self._condition.notify_all()

    def counts(self) -> Dict[str, int]:
        with self._condition:
            return {
                "queued": sum(1 for item in self._jobs.values() if item.status == "queued"),
                "active": sum(1 for item in self._jobs.values() if item.status in ("recognizing", "planning")),
            }


class JobCoordinator:
    def __init__(
        self,
        store: JobStore,
        recognition: RecognitionPort,
        planner: FormattingPlannerPort,
        stage_timeout_seconds: float = 120.0,
    ) -> None:
        self.store = store
        self.recognition = recognition
        self.planner = planner
        self.stage_timeout_seconds = stage_timeout_seconds
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="wps-control-coordinator", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self.store.close()
        if self._thread:
            self._thread.join(timeout=2.0)

    def _run(self) -> None:
        while not self._stop.is_set():
            job = self.store.take_next()
            if job is not None:
                self._execute(job)

    def _invoke(self, callback: Any, *args: Any) -> Any:
        # The coordinator is already outside the HTTP event loop.  A bounded
        # one-worker executor provides a stage timeout and lets cooperative
        # adapters observe cancellation without creating an unbounded pool.
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="wps-control-stage")
        future = executor.submit(callback, *args)
        try:
            value = future.result(timeout=self.stage_timeout_seconds)
            if inspect.isawaitable(value):
                raise ContractError("CONTROL_SERVER_ASYNC_PORT_UNSUPPORTED")
            return value
        except FutureTimeout as exc:
            args[-1].cancel()
            future.cancel()
            raise ContractError("CONTROL_SERVER_JOB_TIMEOUT") from exc
        finally:
            executor.shutdown(wait=False)

    def _execute(self, job: JobRecord) -> None:
        started = time.monotonic()
        try:
            if not self.store.set_running(job, "recognizing"):
                return
            recognition_started = time.monotonic()
            recognition = self._invoke(self.recognition.recognize, job.request["snapshot"], job.cancellation)
            job.metrics["recognition_ms"] = (time.monotonic() - recognition_started) * 1000
            if not isinstance(recognition, dict):
                raise ContractError("RECOGNITION_RESULT_INVALID")
            job.cancellation.raise_if_cancelled()
            formatting: Dict[str, Any] = {}
            if job.request["mode"] != "recognize_only":
                if not self.store.set_running(job, "planning"):
                    return
                planning_started = time.monotonic()
                formatting = self._invoke(self.planner.plan, recognition, job.request, job.cancellation)
                job.metrics["planning_ms"] = (time.monotonic() - planning_started) * 1000
                if not isinstance(formatting, dict):
                    raise ContractError("FORMATTING_PLAN_INVALID")
            else:
                job.metrics["planning_ms"] = 0.0
            job.metrics["total_ms"] = (time.monotonic() - started) * 1000
            result = {
                "schema_version": 1,
                "job_id": job.job_id,
                "request_id": job.request["request_id"],
                "document_token": job.request["document_token"],
                "snapshot_sha256": job.request["snapshot_sha256"],
                "recognition_result": recognition,
                "formatting_plan": formatting,
                "warnings": [],
                "metrics": dict(job.metrics),
            }
            validate_result(result)
            self.store.finish(job, result)
        except ContractError as exc:
            self.store.finish(job, None, exc.code)
        except Exception:  # noqa: BLE001 - never expose adapter internals
            self.store.finish(job, None, "CONTROL_SERVER_JOB_FAILED")
