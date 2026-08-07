from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import main

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-runtime"))
import job_broker  # noqa: E402


def timestamp(offset_seconds: float = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).isoformat().replace("+00:00", "Z")


def current_manifest() -> dict[str, object]:
    return {
        "schema_version": 1,
        "contract_version": 1,
        "broker_version": "1.3.2",
        "broker_executable_path_hash": "path-hash",
        "broker_sha256": "broker-hash",
        "runtime_version": "docxtool-4.0",
        "executable_sha256": "runtime-hash",
        "queue_contract_version": 1,
        "broker_executable_path": r"C:\runtime\docxtool-job-broker.exe",
    }


def broker_status(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schema_version": 1,
        "state": "READY",
        "pid": 3210,
        "broker_instance_id": "broker-instance",
        "process_created_at": timestamp(),
        "broker_version": "1.3.2",
        "broker_executable_path_hash": "path-hash",
        "broker_executable_sha256": "broker-hash",
        "contract_version": 1,
        "queue_contract_version": 1,
        "runtime_version": "docxtool-4.0",
        "runtime_sha256": "runtime-hash",
        "heartbeat_at": timestamp(),
    }
    value.update(changes)
    return value


def test_read_broker_status_distinguishes_missing_and_invalid(tmp_path: Path) -> None:
    missing, missing_error = main.read_broker_status(tmp_path / "status.json")
    assert missing == {}
    assert missing_error is not None
    assert missing_error.error_code == "LOCAL_JOB_BROKER_STATUS_MISSING"

    status_path = tmp_path / "status.json"
    status_path.write_text("{", encoding="utf-8")
    invalid, invalid_error = main.read_broker_status(status_path)
    assert invalid == {}
    assert invalid_error is not None
    assert invalid_error.error_code == "LOCAL_JOB_BROKER_STATUS_INVALID"


def test_quick_readiness_checks_all_contract_fields_without_process_query(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(main, "query_process_metadata", lambda _pid: pytest.fail("快速检查不能查询进程"))
    readiness = main.broker_quick_readiness(current_manifest(), broker_status())
    assert readiness.ready is True
    assert readiness.error_code is None


def test_timestamps_match_wmi_seven_digit_fraction() -> None:
    assert main.timestamps_match("2026-08-06T14:31:09.301944Z", "2026-08-06T14:31:09.3019440Z")
    assert main.timestamps_match("2026-08-06T16:00:12.3198240Z", "2026-08-07T00:00:12+0800")


@pytest.mark.parametrize(
    ("changes", "error_code"),
    [
        ({"state": "FAILED"}, "LOCAL_JOB_BROKER_STATE_INVALID"),
        ({"heartbeat_at": "invalid"}, "LOCAL_JOB_BROKER_HEARTBEAT_INVALID"),
        ({"heartbeat_at": timestamp(-10)}, "LOCAL_JOB_BROKER_HEARTBEAT_STALE"),
        ({"broker_version": "old"}, "LOCAL_JOB_BROKER_VERSION_MISMATCH"),
        ({"runtime_version": "old"}, "LOCAL_JOB_BROKER_RUNTIME_VERSION_MISMATCH"),
        ({"runtime_sha256": "old"}, "LOCAL_JOB_BROKER_RUNTIME_HASH_MISMATCH"),
        ({"broker_executable_sha256": "old"}, "LOCAL_JOB_BROKER_EXECUTABLE_HASH_MISMATCH"),
        ({"queue_contract_version": 2}, "LOCAL_JOB_BROKER_QUEUE_CONTRACT_MISMATCH"),
        ({"contract_version": 2}, "LOCAL_JOB_BROKER_CONTRACT_MISMATCH"),
        ({"pid": 0}, "LOCAL_JOB_BROKER_PID_MISMATCH"),
    ],
)
def test_quick_readiness_returns_specific_error(changes: dict[str, object], error_code: str) -> None:
    readiness = main.broker_quick_readiness(current_manifest(), broker_status(**changes))
    assert readiness.ready is False
    assert readiness.error_code == error_code
    assert readiness.reason_cn
    assert readiness.action_cn


def test_process_identity_is_checked_once_after_quick_check(monkeypatch: pytest.MonkeyPatch) -> None:
    status = broker_status()
    calls = 0

    def query(_pid: object) -> main.ProcessMetadataResult:
        nonlocal calls
        calls += 1
        return main.ProcessMetadataResult(
            {
                "pid": status["pid"],
                "executable_path": current_manifest()["broker_executable_path"],
                "command_line": r"C:\runtime\docxtool-job-broker.exe run",
                "process_created_at": status["process_created_at"],
            },
            "ready",
        )

    monkeypatch.setattr(main, "query_process_metadata", query)
    readiness = main.broker_readiness(current_manifest(), status)
    assert readiness.ready is True
    assert calls == 1


def test_process_identity_accepts_pyinstaller_child_with_blank_wmi_path(monkeypatch: pytest.MonkeyPatch) -> None:
    executable = Path(current_manifest()["broker_executable_path"])
    path_hash = main.broker_executable_path_hash(executable)
    current = {**current_manifest(), "broker_executable_path_hash": path_hash}
    status = broker_status(broker_executable_path_hash=path_hash)
    monkeypatch.setattr(
        main,
        "query_process_metadata",
        lambda _pid: main.ProcessMetadataResult(
            {
                "name": executable.name,
                "executable_path": None,
                "command_line": None,
                "parent_name": executable.name,
                "process_created_at": status["process_created_at"],
            },
            "ready",
        ),
    )

    readiness = main.broker_readiness(current, status)

    assert readiness.ready is True


@pytest.mark.parametrize(
    ("metadata", "state", "error_code"),
    [
        ({}, "not_running", "LOCAL_JOB_BROKER_PROCESS_NOT_RUNNING"),
        ({}, "unavailable", "LOCAL_JOB_BROKER_PROCESS_METADATA_UNAVAILABLE"),
        ({"executable_path": r"C:\other\broker.exe", "command_line": "docxtool-job-broker", "process_created_at": timestamp()}, "ready", "LOCAL_JOB_BROKER_EXECUTABLE_IDENTITY_MISMATCH"),
        ({"executable_path": r"C:\runtime\docxtool-job-broker.exe", "command_line": "other.exe", "process_created_at": timestamp()}, "ready", "LOCAL_JOB_BROKER_COMMAND_LINE_MISMATCH"),
        ({"executable_path": r"C:\runtime\docxtool-job-broker.exe", "command_line": "docxtool-job-broker.exe run", "process_created_at": timestamp(-30)}, "ready", "LOCAL_JOB_BROKER_PROCESS_TIME_MISMATCH"),
    ],
)
def test_process_identity_returns_specific_error(
    monkeypatch: pytest.MonkeyPatch,
    metadata: dict[str, object],
    state: str,
    error_code: str,
) -> None:
    monkeypatch.setattr(main, "query_process_metadata", lambda _pid: main.ProcessMetadataResult(metadata, state, "test"))
    readiness = main.broker_process_readiness(current_manifest(), broker_status())
    assert readiness.ready is False
    assert readiness.error_code == error_code


def test_start_wait_uses_real_ten_second_monotonic_budget_without_warning(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    executable = tmp_path / "docxtool-job-broker.exe"
    executable.write_bytes(b"broker")
    current = {**current_manifest(), "broker_executable_path": str(executable), "broker_sha256": hashlib.sha256(b"broker").hexdigest()}
    appdata_root = tmp_path / "Docxtool"
    process_file = tmp_path / "local-job-broker-process.json"
    monkeypatch.setattr(main, "broker_current", lambda: current)
    monkeypatch.setattr(main, "appdata_docxtool_root", lambda: appdata_root)
    monkeypatch.setattr(main, "JOB_BROKER_PROCESS", process_file)

    status_error = main.broker_failure(
        "LOCAL_JOB_BROKER_STATUS_MISSING",
        "Broker 状态文件尚未生成",
        "等待 Broker 写入状态文件",
    )
    monkeypatch.setattr(main, "read_broker_status", lambda _path: ({}, status_error))
    monkeypatch.setattr(main, "query_process_metadata", lambda _pid: pytest.fail("状态未通过快速检查时不能查询进程"))
    events: list[tuple[str, str]] = []
    monkeypatch.setattr(main, "log_event", lambda level, event, _message, _data=None, _error=None: events.append((level, event)))

    class FakeProcess:
        pid = 4321

        def poll(self) -> None:
            return None

    monkeypatch.setattr(main.subprocess, "Popen", lambda *args, **kwargs: FakeProcess())
    clock = [0.0]
    monkeypatch.setattr(main.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(main.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))

    with pytest.raises(main.StepFailed) as raised:
        main.ensure_job_broker()
    assert raised.value.error_code == "LOCAL_JOB_BROKER_READY_TIMEOUT"
    assert clock[0] == pytest.approx(10.0, abs=0.11)
    assert not any(level == "WARN" for level, _event in events)


def test_start_wait_checks_process_identity_at_most_once(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    executable = tmp_path / "docxtool-job-broker.exe"
    executable.write_bytes(b"broker")
    current = {**current_manifest(), "broker_executable_path": str(executable), "broker_sha256": hashlib.sha256(b"broker").hexdigest()}
    appdata_root = tmp_path / "Docxtool"
    process_file = tmp_path / "local-job-broker-process.json"
    monkeypatch.setattr(main, "broker_current", lambda: current)
    monkeypatch.setattr(main, "appdata_docxtool_root", lambda: appdata_root)
    monkeypatch.setattr(main, "JOB_BROKER_PROCESS", process_file)
    missing = main.broker_failure("LOCAL_JOB_BROKER_STATUS_MISSING", "状态文件尚未生成", "等待 Broker")
    ready_status = broker_status(pid=4322)
    reads = 0

    def read_status(_path: Path) -> tuple[dict[str, object], main.BrokerReadiness | None]:
        nonlocal reads
        reads += 1
        return ({}, missing) if reads == 1 else (ready_status, None)

    monkeypatch.setattr(main, "read_broker_status", read_status)
    identity_calls = 0

    def identity(_current: dict[str, object], _status: dict[str, object]) -> main.BrokerReadiness:
        nonlocal identity_calls
        identity_calls += 1
        return main.broker_failure("LOCAL_JOB_BROKER_PROCESS_METADATA_UNAVAILABLE", "无法读取进程身份", "检查查询权限")

    monkeypatch.setattr(main, "broker_process_readiness", identity)
    monkeypatch.setattr(main, "broker_quick_readiness", lambda _current, _status: main.broker_ready())

    class FakeProcess:
        pid = 4322

        def poll(self) -> None:
            return None

    monkeypatch.setattr(main.subprocess, "Popen", lambda *args, **kwargs: FakeProcess())
    clock = [0.0]
    monkeypatch.setattr(main.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(main.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))

    with pytest.raises(main.StepFailed) as raised:
        main.ensure_job_broker()
    assert raised.value.error_code == "LOCAL_JOB_BROKER_PROCESS_METADATA_UNAVAILABLE"
    assert identity_calls == 1


def test_known_previous_build_switches_with_info_only(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    executable = tmp_path / "docxtool-job-broker.exe"
    executable.write_bytes(b"broker")
    digest = hashlib.sha256(b"broker").hexdigest()
    current = {**current_manifest(), "broker_executable_path": str(executable), "broker_sha256": digest}
    old_status = broker_status(pid=4310, broker_executable_sha256="previous-build")
    ready_status = broker_status(pid=4323, broker_instance_id="current-instance", broker_executable_sha256=digest)
    reads = 0

    def read_status(_path: Path) -> tuple[dict[str, object], main.BrokerReadiness | None]:
        nonlocal reads
        reads += 1
        return (old_status, None) if reads == 1 else (ready_status, None)

    monkeypatch.setattr(main, "broker_current", lambda: current)
    monkeypatch.setattr(main, "appdata_docxtool_root", lambda: tmp_path / "Docxtool")
    monkeypatch.setattr(main, "JOB_BROKER_PROCESS", tmp_path / "broker-process.json")
    monkeypatch.setattr(main, "read_broker_status", read_status)
    monkeypatch.setattr(main, "managed_broker_process", lambda *_args: True)
    monkeypatch.setattr(main, "broker_process_readiness", lambda *_args: main.broker_ready())
    monkeypatch.setattr(main.subprocess, "run", lambda *args, **kwargs: None)
    events: list[tuple[str, str]] = []
    monkeypatch.setattr(main, "log_event", lambda level, event, *_args, **_kwargs: events.append((level, event)))

    class FakeProcess:
        pid = 4323

        def poll(self) -> None:
            return None

    monkeypatch.setattr(main.subprocess, "Popen", lambda *args, **kwargs: FakeProcess())

    result = main.ensure_job_broker()

    assert result["pid"] == 4323
    assert ("INFO", "broker.switch.start") in events
    assert ("INFO", "broker.switch.completed") in events
    assert not any(level == "WARN" for level, _event in events)


def test_broker_startup_writes_lifecycle_events(tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    runtime.mkdir(parents=True)
    recognizer = runtime / "docxtool-recognize.exe"
    recognizer.write_bytes(b"recognizer")
    broker_path = Path(main.sys.executable).resolve()
    current = {
        "schema_version": 1,
        "contract_version": 1,
        "runtime_version": "docxtool-test",
        "executable_path": str(recognizer),
        "executable_sha256": hashlib.sha256(b"recognizer").hexdigest(),
        "broker_executable_path": str(broker_path),
        "broker_executable_path_hash": hashlib.sha256(str(broker_path).replace("/", "\\").casefold().encode("utf-8")).hexdigest(),
        "broker_sha256": hashlib.sha256(broker_path.read_bytes()).hexdigest(),
        "broker_version": "1.3.2",
        "broker_contract_version": 1,
        "queue_contract_version": 1,
    }
    (runtime / "current.json").write_text(json.dumps(current), encoding="utf-8")
    log_path = tmp_path / "wps-plugin.log"
    broker = job_broker.JobBroker(job_broker.BrokerConfig(tmp_path, log_path=log_path))
    broker.startup()
    text = log_path.read_text(encoding="utf-8")
    assert "本地任务代理进程已启动" in text
    assert "运行时清单校验通过" in text
    assert "本地任务代理已就绪" in text


def runtime_build_fixture(tmp_path: Path) -> tuple[Path, dict[str, object]]:
    installed = tmp_path / "installed"
    installed.mkdir()
    recognizer = installed / "docxtool-recognize.exe"
    broker = installed / "docxtool-job-broker.exe"
    recognizer.write_bytes(b"recognizer")
    broker.write_bytes(b"broker")
    manifest = {
        "contract_version": 1,
        "runtime_version": "docxtool-test",
        "executable": recognizer.name,
        "executable_sha256": hashlib.sha256(b"recognizer").hexdigest(),
        "broker_version": "1.3.2",
        "broker_executable": broker.name,
        "broker_sha256": hashlib.sha256(b"broker").hexdigest(),
        "broker_contract_version": 1,
        "queue_contract_version": 1,
        "recognition_package_version": "4.0",
    }
    manifest_path = tmp_path / "runtime-manifest.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    current = {
        **manifest,
        "executable_path": str(recognizer),
        "broker_executable_path": str(broker),
        "recognition_package_version": "4.0",
    }
    return manifest_path, current


def test_start_reuses_matching_runtime_without_rebuild(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manifest_path, current = runtime_build_fixture(tmp_path)
    monkeypatch.setattr(main, "LOCAL_RUNTIME_MANIFEST", manifest_path)
    monkeypatch.setattr(main, "broker_current", lambda: current)
    monkeypatch.setattr(main, "ensure_job_broker", lambda: {})
    monkeypatch.setattr(main, "log_event", lambda *args, **kwargs: None)
    commands: list[str] = []
    monkeypatch.setattr(main, "run_step", lambda _title, command, _success, **_kwargs: commands.append(command))

    main.prepare(rebuild_runtime=False)

    assert "npm run build:local-runtime" not in commands
    assert "npm run install:local-runtime" not in commands
    assert "npm run build:classified" in commands


def test_start_rebuilds_runtime_when_build_manifest_differs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    manifest_path, current = runtime_build_fixture(tmp_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["broker_sha256"] = "different-build"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(main, "LOCAL_RUNTIME_MANIFEST", manifest_path)
    monkeypatch.setattr(main, "broker_current", lambda: current)
    monkeypatch.setattr(main, "ensure_job_broker", lambda: {})
    monkeypatch.setattr(main, "log_event", lambda *args, **kwargs: None)
    commands: list[str] = []
    monkeypatch.setattr(main, "run_step", lambda _title, command, _success, **_kwargs: commands.append(command))

    main.prepare(rebuild_runtime=False)

    assert commands[:2] == ["npm run build:local-runtime", "npm run install:local-runtime"]


def test_status_is_emitted_as_one_grouped_multiline_event(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(main, "run_command", lambda *_args, **_kwargs: "\n".join((
        "repository_head: abc1234",
        "plugin_build: READY",
        "plugin_registration: READY",
        "local_runtime: READY",
        "runtime_executable_exists: YES",
        "local_agent: NOT_USED",
        "command_service: NOT_USED",
        "port_9528: CLOSED",
    )))
    monkeypatch.setattr(main, "is_port_open", lambda _port: False)
    monkeypatch.setattr(main, "diagnostic_events", lambda: [{"event": "host.module.loaded"}])
    monkeypatch.setattr(main, "broker_current", current_manifest)
    monkeypatch.setattr(main, "read_json", lambda path: {"version": "1.5.7"} if path.name == "package.json" else {})
    status = broker_status()
    monkeypatch.setattr(main, "read_broker_status", lambda _path: (status, None))
    monkeypatch.setattr(main, "broker_readiness", lambda *_args: main.broker_ready())
    monkeypatch.setattr(main, "control_server_health", lambda: {"status": "ready", "port": 57729})
    monkeypatch.setattr(main, "wps_is_running", lambda: False)
    events: list[tuple[str, str, str, dict[str, object]]] = []
    monkeypatch.setattr(main, "log_event", lambda level, event, message, data=None, *_args, **_kwargs: events.append((level, event, message, data or {})))

    main.print_status(startup=True, watch_logs=True)

    assert capsys.readouterr().out == ""
    assert len(events) == 1
    assert events[0][:3] == ("INFO", "launcher.status.summary", "WPS 启动状态汇总")
    lines = events[0][3]["summary_lines"]
    assert isinstance(lines, list) and len(lines) == 8
    assert any("产品 v1.5.7；提交 abc1234" in line for line in lines)
    assert any("本地识别：组件已安装" in line for line in lines)
    assert any("统一日志：wps-plugin.log" in line for line in lines)


def test_wps_load_completion_is_emitted_once_after_all_required_events(monkeypatch: pytest.MonkeyPatch) -> None:
    events = [{"event": event, "build_id": "build-1"} for event in main.WPS_LOAD_REQUIRED_EVENTS]
    monkeypatch.setattr(main, "_wps_load_completion_logged", False)
    monkeypatch.setattr(main, "read_json", lambda _path: {"build_id": "build-1"})
    logged: list[tuple[str, str, str, dict[str, object]]] = []
    monkeypatch.setattr(main, "log_event", lambda level, event, message, data=None, *_args, **_kwargs: logged.append((level, event, message, data or {})))

    assert main.maybe_log_wps_load_completed(events[:-1]) is False
    assert logged == []
    assert main.maybe_log_wps_load_completed(events) is True
    assert main.maybe_log_wps_load_completed(events) is True
    assert len(logged) == 1
    assert logged[0][:3] == ("INFO", "wps.load.completed", "WPS 加载完成")
    assert logged[0][3]["build_id"] == "build-1"
