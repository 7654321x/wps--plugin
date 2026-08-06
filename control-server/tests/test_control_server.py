from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import pytest

from wps_control_server.contracts import ContractError, validate_job_request
from wps_control_server.ports import CallableFormattingPlannerPort, CallableRecognitionPort
from wps_control_server.server import ControlServer, ControlServerConfig


def request(server: ControlServer, method: str, path: str, payload=None, token=None):
    headers = {
        "Authorization": "Bearer " + (token or server.session_token),
        "Host": "127.0.0.1",
    }
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(server.manifest["base_url"] + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=2) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read().decode("utf-8"))


def valid_request(request_id=None, mode="preview"):
    return {
        "schema_version": 1,
        "request_id": request_id or str(uuid.uuid4()),
        "mode": mode,
        "document_token": "doc-token",
        "document_revision": "revision-1",
        "snapshot_sha256": "a" * 64,
        "snapshot": {"snapshot_contract_version": "worker-snapshot-v1", "paragraphs": []},
    }


@pytest.fixture()
def running_server(tmp_path: Path):
    recognition = CallableRecognitionPort(lambda snapshot, cancellation: {"schema_version": "test", "paragraphs": []})
    planner = CallableFormattingPlannerPort(lambda recognition, payload, cancellation: {"commands": [], "request_id": payload["request_id"]})
    server = ControlServer(ControlServerConfig(port=0, manifest_path=tmp_path / "endpoint.json", stage_timeout_seconds=1), recognition, planner)
    server.start()
    try:
        yield server
    finally:
        server.close()


def test_manifest_is_loopback_random_and_health(running_server):
    manifest = running_server.manifest
    assert manifest["host"] == "127.0.0.1"
    assert manifest["port"] != 9528
    assert manifest["port"] >= 1024
    assert manifest["instance_id"]
    assert manifest["process_created_at"]
    status, value = request(running_server, "GET", "/v1/health")
    assert status == 200
    assert value["status"] == "ready"


def test_authentication_and_non_loopback_host_are_rejected(running_server):
    status, value = request(running_server, "GET", "/v1/health", token="wrong")
    assert status == 401
    assert value["error"]["code"] == "CONTROL_SERVER_UNAUTHORIZED"
    req = urllib.request.Request(running_server.manifest["base_url"] + "/v1/health", headers={"Authorization": "Bearer " + running_server.session_token, "Host": "evil.example"})
    with pytest.raises(urllib.error.HTTPError) as caught:
        urllib.request.urlopen(req, timeout=2)
    assert caught.value.code == 403


def test_submit_is_immediate_idempotent_and_result_is_strict(running_server):
    payload = valid_request()
    started = time.monotonic()
    status, submitted = request(running_server, "POST", "/v1/jobs", payload)
    assert status == 202
    assert time.monotonic() - started < 0.5
    duplicate_status, duplicate = request(running_server, "POST", "/v1/jobs", payload)
    assert duplicate_status == 202
    assert duplicate["job_id"] == submitted["job_id"]
    deadline = time.monotonic() + 2
    final = None
    while time.monotonic() < deadline:
        _, final = request(running_server, "GET", "/v1/jobs/" + submitted["job_id"])
        if final["status"] == "completed":
            break
        time.sleep(0.02)
    assert final["status"] == "completed"
    result_status, result = request(running_server, "GET", "/v1/jobs/" + submitted["job_id"] + "/result")
    assert result_status == 200
    assert result["request_id"] == payload["request_id"]
    assert result["formatting_plan"]["commands"] == []


def test_only_one_queued_job_is_allowed(running_server):
    gate = threading.Event()
    running_server.coordinator.recognition = CallableRecognitionPort(lambda snapshot, cancellation: (gate.wait(1), {"paragraphs": []})[1])
    first_status, first = request(running_server, "POST", "/v1/jobs", valid_request())
    assert first_status == 202
    time.sleep(0.05)
    second_status, _ = request(running_server, "POST", "/v1/jobs", valid_request())
    assert second_status == 202
    third_status, third = request(running_server, "POST", "/v1/jobs", valid_request())
    assert third_status == 409
    assert third["error"]["code"] == "CONTROL_SERVER_JOB_REJECTED"
    gate.set()


def test_cancel_is_idempotent(running_server):
    gate = threading.Event()
    running_server.coordinator.recognition = CallableRecognitionPort(lambda snapshot, cancellation: (gate.wait(1), {"paragraphs": []})[1])
    _, submitted = request(running_server, "POST", "/v1/jobs", valid_request())
    time.sleep(0.05)
    first_status, first = request(running_server, "POST", "/v1/jobs/" + submitted["job_id"] + "/cancel")
    second_status, second = request(running_server, "POST", "/v1/jobs/" + submitted["job_id"] + "/cancel")
    assert first_status == second_status == 202
    assert first["status"] in ("recognizing", "cancelled")
    assert second["status"] in ("recognizing", "cancelled")
    gate.set()


def test_contract_rejects_execution_fields():
    payload = valid_request()
    payload["snapshot"]["executable"] = "bad.exe"
    with pytest.raises(ContractError) as caught:
        validate_job_request(payload)
    assert caught.value.code == "CONTROL_SERVER_EXECUTION_FIELD_REJECTED"
