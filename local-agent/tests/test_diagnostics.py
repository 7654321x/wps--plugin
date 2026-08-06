import io
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from wsgiref.util import setup_testing_defaults


ROOT = Path(__file__).resolve().parents[1]
WPS_ROOT = ROOT.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(WPS_ROOT / "command-service" / "src"))

from docxtool_local_agent.app import create_app  # noqa: E402
from docxtool_local_agent.diagnostics import (  # noqa: E402
    DiagnosticLogWriter,
    validate_batch,
)
from wps_logging import parse_log_line  # noqa: E402


def _call(app, method, path, body=None, *, raw=None, token="test-token"):
    environ = {}
    setup_testing_defaults(environ)
    environ["REQUEST_METHOD"] = method
    environ["PATH_INFO"] = path
    environ["HTTP_X_DOCXTOOL_SESSION"] = token
    data = raw if raw is not None else json.dumps(body or {}).encode("utf-8")
    environ["CONTENT_LENGTH"] = str(len(data))
    environ["wsgi.input"] = io.BytesIO(data)
    captured = {}
    response = b"".join(
        app(
            environ,
            lambda status, headers: captured.update(
                status=status,
                headers=dict(headers),
            ),
        )
    )
    return captured["status"], json.loads(response.decode("utf-8"))


def _event(name="preview.failed", **extra):
    return {
        "timestamp": "2026-08-05T00:00:00Z",
        "level": "ERROR",
        "component": "host",
        "event": name,
        "message": "诊断事件",
        **extra,
    }


def test_writer_creates_utf8_chinese_lines_and_redacts_twice(tmp_path):
    path = tmp_path / "wps-plugin.log"
    writer = DiagnosticLogWriter(path)
    events = validate_batch({
        "schema_version": 1,
        "source": "host",
        "events": [_event(
            data={
                "token": "must-not-appear",
                "raw_text": "secret paragraph",
                "FullName": r"C:\Users\private\secret.docx",
                "path": r"D:\private\file.docx",
                "endpoint_path": "/v1/recognize",
                "endpoint_origin": "http://127.0.0.1:9528",
                "content_length": 12,
            },
            error={
                "name": "Error",
                "message": "authorization=must-not-appear",
                "stack": r"stack-value at C:\Users\private\source.py:12",
            },
        )],
    })
    writer.append(events)

    value = path.read_text(encoding="utf-8")
    assert "preview.failed" in value
    assert "[错误]" in value
    assert "阶段：" in value
    assert "must-not-appear" not in value
    assert "secret paragraph" not in value
    assert "stack-value" not in value
    assert "private\\source.py" not in value
    assert "{" not in value and "}" not in value
    assert parse_log_line(value.strip()) is not None
    assert writer.path_info()["file_name"] == "wps-plugin.log"

    rotating_path = tmp_path / "rotate.log"
    rotating = DiagnosticLogWriter(rotating_path, max_bytes=500, backup_count=2)
    for index in range(20):
        rotating.append([_event("rotation.{}".format(index), data={"size": "x" * 20})])
    assert rotating_path.is_file()
    assert rotating_path.stat().st_size <= 500
    assert not (tmp_path / "rotate.log.1").exists()


def test_writer_concurrent_append_never_produces_partial_lines(tmp_path):
    path = tmp_path / "concurrent.log"
    writer = DiagnosticLogWriter(path)
    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(lambda index: writer.append([_event("parallel.{}".format(index))]), range(100)))
    lines = path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 100
    assert all(parse_log_line(line) is not None for line in lines)


def test_diagnostic_endpoint_auth_status_and_server_redaction(tmp_path):
    path = tmp_path / "wps-plugin.log"
    app = create_app("test-token", diagnostic_log_file=path)
    payload = {"schema_version": 1, "source": "host", "events": [_event(data={"raw_text": "secret paragraph", "token": "must-not-appear"})]}

    status, unauthorized = _call(app, "POST", "/v1/diagnostics/logs", payload, token="wrong-token")
    assert status == "401 Unauthorized"
    assert unauthorized["error_code"] == "UNAUTHORIZED"

    status, accepted = _call(app, "POST", "/v1/diagnostics/logs", payload)
    assert status == "200 OK"
    assert accepted == {"ok": True, "accepted": 1}

    status, info = _call(app, "GET", "/v1/diagnostics/status")
    assert status == "200 OK"
    assert info["file_name"] == "wps-plugin.log"
    assert info["exists"] is True
    assert set(info) == {"ok", "file_name", "exists", "size_bytes"}
    assert str(tmp_path) not in json.dumps(info)

    value = path.read_text(encoding="utf-8")
    assert "secret paragraph" not in value
    assert "must-not-appear" not in value
    assert "[错误]" in value
    assert "local_agent.request.received" in value
    assert "local_agent.request.completed" in value


def test_diagnostic_endpoint_rejects_invalid_batches_and_limits(tmp_path):
    app = create_app("test-token", diagnostic_log_file=tmp_path / "debug.log")

    cases = [
        ({"schema_version": 2, "source": "host", "events": [_event()]}, "DIAGNOSTIC_SCHEMA_UNSUPPORTED"),
        ({"schema_version": 1, "source": "launcher", "events": [_event()]}, "DIAGNOSTIC_SOURCE_INVALID"),
        ({"schema_version": 1, "source": "host", "events": [{**_event(), "level": "NOTICE"}]}, "DIAGNOSTIC_LEVEL_INVALID"),
        ({"schema_version": 1, "source": "host", "events": [_event("count.{}".format(index)) for index in range(101)]}, "DIAGNOSTIC_EVENT_COUNT_INVALID"),
        ({"schema_version": 1, "source": "host", "events": [_event(data={"note": "x" * (70 * 1024)})]}, "DIAGNOSTIC_EVENT_TOO_LARGE"),
    ]
    for payload, error_code in cases:
        status, result = _call(app, "POST", "/v1/diagnostics/logs", payload)
        assert status == "400 Bad Request"
        assert result["error_code"] == error_code

    oversized = b'{"schema_version":1,"source":"host","events":[],"padding":"' + (b"x" * (513 * 1024)) + b'"}'
    status, result = _call(app, "POST", "/v1/diagnostics/logs", raw=oversized)
    assert status == "400 Bad Request"
    assert result["error_code"] == "DIAGNOSTIC_BATCH_TOO_LARGE"
