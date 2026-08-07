from pathlib import Path

from wps_logging import UnifiedLogWriter, format_event, parse_log_line


def error_event(code: str, request_id: str = "request-1") -> dict:
    return {
        "timestamp": "2026-08-06T12:00:00Z",
        "level": "ERROR",
        "component": "host",
        "event": "application.runtime.failed",
        "message": "请求执行失败",
        "request_id": request_id,
        "data": {"stable_error_code": code},
    }


def test_format_event_is_chinese_and_has_no_json_object() -> None:
    line = format_event(error_event("LOCAL_RUNTIME_CONFIGURATION_REQUIRED"))

    assert "[错误] [WPS宿主]" in line
    assert "阶段：" in line
    assert "原因：" in line
    assert "处理建议：" in line
    assert "错误码：LOCAL_RUNTIME_CONFIGURATION_REQUIRED" in line
    assert not line.lstrip().startswith("{")
    assert parse_log_line(line)["stable_error_code"] == "LOCAL_RUNTIME_CONFIGURATION_REQUIRED"


def test_format_event_supports_one_redacted_multiline_summary() -> None:
    rendered = format_event({
        "timestamp": "2026-08-07T05:30:00Z",
        "level": "INFO",
        "component": "main",
        "event": "launcher.status.summary",
        "message": "WPS 当前状态汇总",
        "data": {
            "summary_lines": [
                "本地识别：Broker 已就绪",
                r"统一日志：D:\private\wps-plugin.log Authorization=secret-token",
            ],
        },
    })

    lines = rendered.splitlines()
    assert len(lines) == 3
    assert parse_log_line(lines[0])["event"] == "launcher.status.summary"
    assert lines[1] == "  - 本地识别：Broker 已就绪"
    assert "[本机路径]" in lines[2]
    assert "secret-token" not in lines[2]


def test_catalog_covers_required_runtime_failures() -> None:
    codes = (
        "LOCAL_RUNTIME_CONFIGURATION_REQUIRED",
        "WPS_FILESYSTEM_PATH_REJECTED",
        "LOCAL_JOB_BROKER_NOT_RUNNING",
        "PIPELINE_WORKER_NOT_READY",
        "TASKPANE_CREATE_FAILED",
        "RIBBON_CALLBACK_NOT_FOUND",
    )

    for code in codes:
        line = format_event(error_event(code))
        assert "阶段：" in line and "原因：" in line and "处理建议：" in line
        assert f"错误码：{code}" in line


def test_repeated_error_is_written_once_until_state_changes(tmp_path: Path) -> None:
    path = tmp_path / "wps-plugin.log"
    writer = UnifiedLogWriter(path)
    event = error_event("LOCAL_JOB_BROKER_NOT_RUNNING")

    assert len(writer.append([event for _ in range(100)])) == 1
    assert len(path.read_text(encoding="utf-8").splitlines()) == 1

    assert len(writer.append([{
        "timestamp": "2026-08-06T12:00:01Z",
        "level": "INFO",
        "component": "broker",
        "event": "broker.ready",
        "message": "本地任务代理已就绪",
    }])) == 1
    assert len(writer.append([event])) == 1
    assert len(path.read_text(encoding="utf-8").splitlines()) == 3


def test_log_redacts_sensitive_values_and_paths(tmp_path: Path) -> None:
    line = format_event({
        "timestamp": "2026-08-06T12:00:00Z",
        "level": "ERROR",
        "component": "host",
        "event": "host.failed",
        "message": r"Request failed at C:\Users\private\secret.docx Authorization=secret-token",
        "data": {
            "source_path": r"D:\private\input.docx",
            "document_text": "涉密正文不应出现",
            "cookie": "cookie-value",
        },
        "error": {"message": r"Error at C:\Users\private\source.py:12"},
    })

    assert r"C:\Users\private" not in line
    assert "secret-token" not in line
    assert "涉密正文不应出现" not in line
    assert "cookie-value" not in line
    assert "{" not in line and "}" not in line


def test_truncation_keeps_complete_lines_without_rotation(tmp_path: Path) -> None:
    path = tmp_path / "wps-plugin.log"
    writer = UnifiedLogWriter(path, max_bytes=900, keep_bytes=500)
    for index in range(30):
        writer.append([{
            "timestamp": "2026-08-06T12:00:00Z",
            "level": "INFO",
            "component": "main",
            "event": f"poll.{index}",
            "message": f"状态变化 {index}",
        }])

    content = path.read_text(encoding="utf-8")
    assert path.stat().st_size <= 500
    assert "历史日志因文件过大已裁剪" in content
    assert not (tmp_path / "wps-plugin.log.1").exists()
    assert all(parse_log_line(line) is not None for line in content.splitlines()[1:])
