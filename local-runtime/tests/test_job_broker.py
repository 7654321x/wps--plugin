from __future__ import annotations

import hashlib
import json
import os
import shutil
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
        "broker_executable_path": str(Path(sys.executable).resolve()),
        "broker_executable_path_hash": job_broker.normalized_path_hash(Path(sys.executable)),
        "broker_sha256": job_broker.file_sha256(Path(sys.executable)),
        "broker_version": "1.3.2",
        "broker_contract_version": 1,
        "queue_contract_version": 1,
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


def test_status_contains_full_broker_identity(tmp_path):
    root = tmp_path / "Docxtool"
    runtime_files(root)
    broker = job_broker.JobBroker(job_broker.BrokerConfig(root))
    broker._write_status("READY")
    status = json.loads((root / "broker" / "status.json").read_text(encoding="utf-8"))
    assert status["broker_instance_id"] == broker.broker_instance_id
    assert status["process_created_at"] == broker.process_created_at
    assert status["broker_version"] == "1.3.2"
    assert status["broker_executable_path_hash"] == job_broker.normalized_path_hash(Path(sys.executable))
    assert status["broker_executable_sha256"] == job_broker.file_sha256(Path(sys.executable))
    assert status["queue_contract_version"] == 1


def test_two_brokers_cannot_claim_or_launch_the_same_job(tmp_path, monkeypatch):
    root = tmp_path / "Docxtool"
    recognizer, _, digest = runtime_files(root)
    job = enqueue(root, "5f47f6a0-10c2-4ed0-a909-6a54e61a8db5")
    (job / "queued.json").write_text((job / "queued.json").read_text(encoding="utf-8").replace("RUNTIME_HASH", digest), encoding="utf-8")
    launches = []

    class FakeProcess:
        pid = 3211

        def __init__(self, argv, **kwargs):
            launches.append(argv)
            self.return_code = None

        def poll(self):
            return self.return_code

        def terminate(self):
            self.return_code = -15

    monkeypatch.setattr(job_broker.subprocess, "Popen", FakeProcess)
    first = job_broker.JobBroker(job_broker.BrokerConfig(root))
    second = job_broker.JobBroker(job_broker.BrokerConfig(root))
    assert first.run_once() is True
    assert second.run_once() is False
    assert len(launches) == 1
    assert json.loads((job / "claimed.json").read_text(encoding="utf-8"))["broker_instance_id"] == first.broker_instance_id


def test_expired_claim_owned_by_dead_broker_is_recovered(tmp_path, monkeypatch):
    root = tmp_path / "Docxtool"
    _, _, digest = runtime_files(root)
    job = enqueue(root, "5f47f6a0-10c2-4ed0-a909-6a54e61a8db5")
    queue = json.loads((job / "queued.json").read_text(encoding="utf-8").replace("RUNTIME_HASH", digest))
    (job / "queued.json").unlink()
    old_claim = {**queue, "broker_instance_id": "old", "broker_pid": 999999, "broker_process_created_at": "2000-01-01T00:00:00Z", "claimed_at": "2000-01-01T00:00:00Z", "lease_until": "2000-01-01T00:00:01Z"}
    (job / "claim.lock").write_text(json.dumps(old_claim), encoding="utf-8")
    (job / "claimed.json").write_text(json.dumps(old_claim), encoding="utf-8")
    launches = []

    class FakeProcess:
        pid = 3212

        def __init__(self, argv, **kwargs):
            launches.append(argv)
            self.return_code = None

        def poll(self):
            return self.return_code

        def terminate(self):
            self.return_code = -15

    monkeypatch.setattr(job_broker.subprocess, "Popen", FakeProcess)
    broker = job_broker.JobBroker(job_broker.BrokerConfig(root))
    assert broker.run_once() is True
    assert (job / "recovery.json").exists()
    assert len(launches) == 1


def test_live_claim_is_not_recovered_before_lease_owner_is_gone(tmp_path, monkeypatch):
    root = tmp_path / "Docxtool"
    _, _, digest = runtime_files(root)
    job = enqueue(root, "5f47f6a0-10c2-4ed0-a909-6a54e61a8db5")
    queue = json.loads((job / "queued.json").read_text(encoding="utf-8").replace("RUNTIME_HASH", digest))
    (job / "queued.json").unlink()
    owner_created = job_broker.process_created_at(os.getpid()) or "now"
    old_claim = {**queue, "broker_instance_id": "live", "broker_pid": os.getpid(), "broker_process_created_at": owner_created, "claimed_at": "2000-01-01T00:00:00Z", "lease_until": "2000-01-01T00:00:01Z"}
    (job / "claim.lock").write_text(json.dumps(old_claim), encoding="utf-8")
    (job / "claimed.json").write_text(json.dumps(old_claim), encoding="utf-8")
    monkeypatch.setattr(job_broker, "owner_alive", lambda _pid, _created: True)
    monkeypatch.setattr(job_broker.subprocess, "Popen", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("live claim must not launch")))
    broker = job_broker.JobBroker(job_broker.BrokerConfig(root))
    assert broker.run_once() is False
    assert not (job / "recovery.json").exists()
    assert (job / "claimed.json").exists()


def test_cancel_after_popen_is_reported_as_during_recognition(tmp_path, monkeypatch):
    root = tmp_path / "Docxtool"
    _, _, digest = runtime_files(root)
    job = enqueue(root, "5f47f6a0-10c2-4ed0-a909-6a54e61a8db5")
    (job / "queued.json").write_text((job / "queued.json").read_text(encoding="utf-8").replace("RUNTIME_HASH", digest), encoding="utf-8")

    class FakeProcess:
        pid = 3213

        def __init__(self, argv, **kwargs):
            self.return_code = None
            (job / "cancel.json").write_text("{}", encoding="utf-8")

        def poll(self):
            return self.return_code

        def terminate(self):
            self.return_code = -15

    monkeypatch.setattr(job_broker.subprocess, "Popen", FakeProcess)
    broker = job_broker.JobBroker(job_broker.BrokerConfig(root))
    assert broker.run_once() is True
    broker.run_once()
    broker.run_once()
    error = json.loads((job / "error.json").read_text(encoding="utf-8"))
    assert error["error_code"] == "CANCELLED_DURING_RECOGNITION"


def test_worker_cleanup_after_result_does_not_create_missing_result_error(tmp_path, monkeypatch):
    root = tmp_path / "Docxtool"
    _, _, digest = runtime_files(root)
    job = enqueue(root, "5f47f6a0-10c2-4ed0-a909-6a54e61a8db5")
    (job / "queued.json").write_text((job / "queued.json").read_text(encoding="utf-8").replace("RUNTIME_HASH", digest), encoding="utf-8")

    class FakeProcess:
        pid = 3214

        def __init__(self, argv, **kwargs):
            self.return_code = None

        def poll(self):
            return self.return_code

        def terminate(self):
            self.return_code = -15

    monkeypatch.setattr(job_broker.subprocess, "Popen", FakeProcess)
    broker = job_broker.JobBroker(job_broker.BrokerConfig(root))
    assert broker.run_once() is True
    broker.active_process.return_code = 0
    shutil.rmtree(job)

    assert broker.run_once() is False
    assert broker.active_process is None
    assert not job.exists()
    assert broker.last_error_code == ""


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
    assert json.loads((cancelled / "error.json").read_text(encoding="utf-8"))["error_code"] == "CANCELLED_BEFORE_LAUNCH"
