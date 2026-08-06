from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import job_broker


def runtime_files(root: Path) -> tuple[Path, Path, str]:
    runtime = root / "runtime"
    runtime.mkdir(parents=True)
    recognizer = runtime / "docxtool-recognize.exe"
    recognizer.write_bytes(b"recognizer-test")
    digest = hashlib.sha256(recognizer.read_bytes()).hexdigest()
    (runtime / "current.json").write_text(json.dumps({
        "schema_version": 1,
        "contract_version": 1,
        "runtime_version": "docxtool-test",
        "executable_path": str(recognizer),
        "executable_sha256": digest,
    }), encoding="utf-8")
    return recognizer, runtime / "current.json", digest


def enqueue(root: Path, job_id: str) -> Path:
    job = root / "jobs" / job_id
    job.mkdir(parents=True)
    (job / "request.json").write_text(json.dumps({
        "schema_version": 1,
        "request_id": job_id,
        "source_path": r"C:\fixture.docx",
        "result_path": str(job / "result.json"),
        "error_path": str(job / "error.json"),
        "host_snapshot": {"host_type": "wps", "paragraphs": []},
    }), encoding="utf-8")
    (job / "queued.json").write_text(json.dumps({
        "schema_version": 1,
        "job_id": job_id,
        "contract_version": 1,
        "runtime_version": "docxtool-test",
        "runtime_sha256": "RUNTIME_HASH",
        "created_at": "2026-08-06T00:00:00Z",
        "build_id": "test-build",
    }), encoding="utf-8")
    return job


def test_atomic_write_and_uuid_validation(tmp_path):
    target = tmp_path / "nested" / "status.json"
    job_broker.atomic_write_json(target, {"state": "READY"})
    assert json.loads(target.read_text(encoding="utf-8")) == {"state": "READY"}
    assert not target.with_name("status.json.tmp").exists()
    assert job_broker.safe_job_id("5f47f6a0-10c2-4ed0-a909-6a54e61a8db5")
    assert not job_broker.safe_job_id("../../bad")


def test_broker_claims_and_launches_one_job(tmp_path, monkeypatch):
    root = tmp_path / "Docxtool"
    recognizer, _, digest = runtime_files(root)
    job_id = "5f47f6a0-10c2-4ed0-a909-6a54e61a8db5"
    job = enqueue(root, job_id)
    (job / "queued.json").write_text((job / "queued.json").read_text(encoding="utf-8").replace("RUNTIME_HASH", digest), encoding="utf-8")

    class FakeProcess:
        pid = 3210
        return_code = None

        def __init__(self, argv, **kwargs):
            assert argv[0] == str(recognizer)
            assert argv[1:3] == ["--request", str(job / "request.json")]
            assert kwargs["shell"] is False
            payload = json.loads((job / "request.json").read_text(encoding="utf-8"))
            (job / "result.json").write_text(json.dumps({"request_id": payload["request_id"], "recognition_plan": {"blocks": []}}), encoding="utf-8")

        def poll(self):
            return self.return_code

        def terminate(self):
            self.return_code = -15

    monkeypatch.setattr(job_broker.subprocess, "Popen", FakeProcess)
    broker = job_broker.JobBroker(job_broker.BrokerConfig(root))
    assert broker.run_once() is True
    assert (job / "claimed.json").exists()
    assert (job / "launched.json").exists()
    assert broker.active_job_id == job_id
    broker.active_process.return_code = 0
    broker.run_once()
    assert (job / "finished.json").exists()
    assert (root / "broker" / "status.json").exists()


def test_broker_rejects_invalid_id_and_cancel_before_launch(tmp_path):
    root = tmp_path / "Docxtool"
    _, _, digest = runtime_files(root)
    invalid = root / "jobs" / "not-a-uuid"
    invalid.mkdir(parents=True)
    (invalid / "queued.json").write_text("{}", encoding="utf-8")
    cancelled = enqueue(root, "5f47f6a0-10c2-4ed0-a909-6a54e61a8db5")
    (cancelled / "queued.json").write_text((cancelled / "queued.json").read_text(encoding="utf-8").replace("RUNTIME_HASH", digest), encoding="utf-8")
    (cancelled / "cancel.json").write_text("{}", encoding="utf-8")
    broker = job_broker.JobBroker(job_broker.BrokerConfig(root))
    broker.run_once()
    assert json.loads((invalid / "error.json").read_text(encoding="utf-8"))["error_code"] == "LOCAL_JOB_INVALID_ID"
    assert json.loads((cancelled / "error.json").read_text(encoding="utf-8"))["error_code"] == "RECOGNITION_CANCELLED"
