from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path

import pytest

from wps_control_server.contracts import ContractError, validate_job_request
from wps_control_server.ports import CallableFormattingPlannerPort, CallableRecognitionPort
from wps_control_server.server import ControlServer, ControlServerConfig


def write_docx(path: Path, broken: bool, broken_target: str = "../NULL", dangling: bool = False) -> None:
    relationship = (
        '<Relationship Id="rIdBad" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="%s"/>' % broken_target
        if broken and not dangling else ""
    )
    drawing = (
        '<w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdBad"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
        if broken else ""
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>')
        archive.writestr("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/_rels/document.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">%s</Relationships>' % relationship)
        archive.writestr("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>fixture</w:t></w:r>%s</w:p><w:sectPr/></w:body></w:document>' % drawing)
        archive.writestr("word/styles.xml", '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"/></w:styles>')


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


def test_wps_resource_origin_cors_preflight_and_response(running_server):
    endpoint = running_server.manifest["base_url"] + "/v1/document-repairs/inspect"
    preflight = urllib.request.Request(
        endpoint,
        method="OPTIONS",
        headers={
            "Origin": "http://127.0.0.1:3889",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    with urllib.request.urlopen(preflight, timeout=2) as response:
        assert response.status == 204
        assert response.headers["Access-Control-Allow-Origin"] == "http://127.0.0.1:3889"
        assert response.headers["Access-Control-Allow-Headers"] == "Authorization, Content-Type"

    request_value = urllib.request.Request(
        running_server.manifest["base_url"] + "/v1/health",
        headers={
            "Authorization": "Bearer " + running_server.session_token,
            "Host": "127.0.0.1",
            "Origin": "http://127.0.0.1:3889",
        },
    )
    with urllib.request.urlopen(request_value, timeout=2) as response:
        assert response.status == 200
        assert response.headers["Access-Control-Allow-Origin"] == "http://127.0.0.1:3889"

    rejected = urllib.request.Request(
        endpoint,
        method="OPTIONS",
        headers={
            "Origin": "http://evil.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    with pytest.raises(urllib.error.HTTPError) as caught:
        urllib.request.urlopen(rejected, timeout=2)
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


def test_document_repair_is_clean_without_creating_a_repair_record(running_server, tmp_path):
    source = tmp_path / "clean.docx"
    write_docx(source, False)
    status, value = request(running_server, "POST", "/v1/document-repairs/inspect", {"schema_version": 1, "source_path": str(source), "document_identity": "doc-1"})
    assert status == 200
    assert value["schema_version"] == 1
    assert value["status"] == "clean"
    assert value["null_relationship_count"] == value["dangling_drawing_count"] == 0
    assert value["package_member_count"] == 5


def test_document_repair_reports_a_stable_error_for_a_missing_source(running_server, tmp_path):
    status, value = request(running_server, "POST", "/v1/document-repairs/inspect", {"schema_version": 1, "source_path": str(tmp_path / "missing.docx"), "document_identity": "doc-1"})
    assert status == 409
    assert value["error"]["code"] == "DOCUMENT_REPAIR_FAILED"
    assert value["error"]["details"]["stage"] == "inspect.source"
    assert value["error"]["details"]["reason"] == "source_path_not_accessible"
    assert value["error"]["details"]["exception_type"] == "FileNotFoundError"


def test_document_repair_removes_null_relationship_and_broken_drawing(running_server, tmp_path):
    source = tmp_path / "broken.docx"
    write_docx(source, True, "../images/../NULL")
    original = source.read_bytes()
    with zipfile.ZipFile(source) as archive:
        original_styles = archive.read("word/styles.xml")
    status, inspected = request(running_server, "POST", "/v1/document-repairs/inspect", {"schema_version": 1, "source_path": str(source), "document_identity": "doc-1"})
    assert status == 200
    repair_id = inspected["repair_id"]
    status, applied = request(running_server, "POST", "/v1/document-repairs/%s/apply" % repair_id, {"schema_version": 1})
    assert status == 200
    assert applied["removed_relationship_count"] == applied["removed_drawing_count"] == 1
    with zipfile.ZipFile(source) as archive:
        assert b"../NULL" not in archive.read("word/_rels/document.xml.rels")
        assert b"rIdBad" not in archive.read("word/document.xml")
        assert archive.read("word/styles.xml") == original_styles
        assert archive.testzip() is None
    status, committed = request(running_server, "POST", "/v1/document-repairs/%s/complete" % repair_id, {"schema_version": 1, "outcome": "commit"})
    assert status == 200
    assert committed["status"] == "committed"
    assert source.read_bytes() != original
    assert not list(tmp_path.glob(".*docxtool-repair-*.docx"))


def test_document_repair_removes_a_dangling_image_drawing_after_wps_drops_the_relationship(running_server, tmp_path):
    source = tmp_path / "dangling.docx"
    write_docx(source, True, dangling=True)
    status, inspected = request(running_server, "POST", "/v1/document-repairs/inspect", {"schema_version": 1, "source_path": str(source), "document_identity": "doc-1"})
    assert status == 200
    assert inspected["status"] == "repair_required"
    assert inspected["null_relationship_count"] == 0
    assert inspected["dangling_drawing_count"] == 1
    status, applied = request(running_server, "POST", "/v1/document-repairs/%s/apply" % inspected["repair_id"], {"schema_version": 1})
    assert status == 200
    assert applied["removed_relationship_count"] == 0
    assert applied["removed_drawing_count"] == 1
    status, committed = request(running_server, "POST", "/v1/document-repairs/%s/complete" % inspected["repair_id"], {"schema_version": 1, "outcome": "commit"})
    assert status == 200
    assert committed["status"] == "committed"
    with zipfile.ZipFile(source) as archive:
        assert b"rIdBad" not in archive.read("word/document.xml")
        assert archive.testzip() is None


def test_document_repair_rejects_changed_source_and_can_restore(running_server, tmp_path):
    source = tmp_path / "broken.docx"
    write_docx(source, True)
    original = source.read_bytes()
    _, inspected = request(running_server, "POST", "/v1/document-repairs/inspect", {"schema_version": 1, "source_path": str(source), "document_identity": "doc-1"})
    source.write_bytes(original + b"changed")
    status, value = request(running_server, "POST", "/v1/document-repairs/%s/apply" % inspected["repair_id"], {"schema_version": 1})
    assert status == 409
    assert value["error"]["code"] == "DOCUMENT_REPAIR_SOURCE_CHANGED"

    write_docx(source, True)
    original = source.read_bytes()
    _, inspected = request(running_server, "POST", "/v1/document-repairs/inspect", {"schema_version": 1, "source_path": str(source), "document_identity": "doc-2"})
    request(running_server, "POST", "/v1/document-repairs/%s/apply" % inspected["repair_id"], {"schema_version": 1})
    status, restored = request(running_server, "POST", "/v1/document-repairs/%s/complete" % inspected["repair_id"], {"schema_version": 1, "outcome": "restore"})
    assert status == 200
    assert restored["status"] == "restored"
    assert source.read_bytes() == original
