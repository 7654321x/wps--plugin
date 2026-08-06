from __future__ import annotations

import argparse
import calendar
import ctypes
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from wps_logging import UnifiedLogWriter, read_log_events


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
if sys.platform == "win32":
    try:
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        ctypes.windll.kernel32.SetConsoleCP(65001)
    except (AttributeError, OSError):
        pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


ROOT = Path(__file__).resolve().parent
WPSJS_PORT = 3889
WPS_LOG = ROOT / "wps-plugin.log"
LOG_WRITER = UnifiedLogWriter(WPS_LOG)
DEBUG_PACKAGE = ROOT / ".runtime" / "wps-debug-package"
DEBUG_MANIFEST = DEBUG_PACKAGE / "debug-package.json"
WPSJS_PROCESS = ROOT / ".runtime" / "wpsjs-debug-process.json"
RESOURCE_PROBE = ROOT / ".runtime" / "resource-probe.json"
JOB_BROKER_PROCESS = ROOT / ".runtime" / "local-job-broker-process.json"
CONTROL_SERVER_PROCESS = ROOT / ".runtime" / "control-server-process.json"


def log_event(level: str, event: str, message: str, data: Optional[Dict[str, object]] = None, error: object = None) -> None:
    event_value: Dict[str, object] = {
        "timestamp": utc_now(),
        "level": level,
        "component": "main",
        "event": event,
        "message": message,
        "data": data or {},
    }
    if error is not None:
        event_value["error"] = {"name": type(error).__name__, "message": str(error)}
    for line in LOG_WRITER.append([event_value]):
        print(line, flush=True)


class StepFailed(RuntimeError):
    def __init__(self, title: str, command: str, output: str) -> None:
        self.title = title
        self.command = command
        self.output = output
        super().__init__(title)


def decode_process_output(value: bytes) -> str:
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return value.decode(encoding)
        except UnicodeDecodeError:
            continue
    return value.decode("utf-8", errors="replace")


def run_command(command: str, *, cwd: Path = ROOT, timeout: int = 180) -> str:
    result = subprocess.run(
        command,
        cwd=str(cwd),
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )
    output = decode_process_output(result.stdout or b"")
    if result.returncode != 0:
        raise StepFailed("命令执行失败", command, output)
    return output


def useful_error(output: str) -> str:
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    for line in reversed(lines):
        if any(token in line for token in ("FAILED", "MISSING", "INVALID", "ERROR", "失败", "缺失", "错误")):
            return line
    return lines[-1] if lines else "没有返回详细错误。"


def run_step(title: str, command: str, success: str, *, cwd: Path = ROOT, timeout: int = 180) -> str:
    log_event("INFO", "launcher.step.start", f"开始{title}", {"stage_cn": title})
    try:
        output = run_command(command, cwd=cwd, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        log_event("ERROR", "launcher.step.failed", f"{title}超时", {"stage_cn": title, "reason_cn": "外部命令在规定时间内没有完成", "action_cn": "检查当前步骤的运行状态后重试", "stable_error_code": "LAUNCHER_STEP_TIMEOUT"}, error)
        raise StepFailed(title, command, str(error)) from error
    except StepFailed as error:
        log_event("ERROR", "launcher.step.failed", f"{title}失败", {"stage_cn": title, "reason_cn": "外部命令返回失败", "action_cn": "查看当前步骤的错误码并修复后重试", "technical_detail": useful_error(error.output)}, error)
        raise
    log_event("INFO", "launcher.step.success", success, {"stage_cn": title, "result_cn": "成功"})
    return output


def parse_status(output: str) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for line in output.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        values[key.strip()] = value.strip()
    return values


def print_status() -> None:
    output = run_command("pwsh -NoProfile -File scripts/local-direct.ps1 status", timeout=60)
    values = parse_status(output)
    print("当前状态：")
    print(f"- 项目版本：{values.get('repository_head', '未知')}")
    print(f"- WPS 插件构建：{'已生成' if values.get('plugin_build') == 'READY' else '未生成'}")
    server_ready = is_port_open(WPSJS_PORT) and probe_debug_server().get("status") == "PASS"
    event_names = [str(item.get("event", "")) for item in diagnostic_events()]
    print(f"- 调试资源服务：{'已验证' if server_ready else '未就绪'}")
    print(f"- WPS 注册配置：{'已登记' if values.get('plugin_registration') else '未确认'}")
    print(f"- WPS 插件页面：{'已加载' if plugin_page_loaded(event_names) else '等待 WPS 重新加载'}")
    print(f"- 本地识别组件：{'已安装' if values.get('local_runtime') == 'READY' else '未安装'}")
    print(f"- 识别程序文件：{'存在' if values.get('runtime_executable_exists') == 'YES' else '不存在'}")
    current = broker_current()
    status = broker_status()
    print(f"- 本地任务 Broker：{'已就绪' if broker_healthy(current, status) else '未就绪'}")
    print(f"- Broker PID：{status.get('pid', '未知')}")
    print(f"- Broker 版本：{status.get('broker_version', '未知')}")
    control = control_server_health()
    print(f"- WPS Control Server：{'已就绪' if control.get('status') == 'ready' else '未就绪'}")
    print(f"- Control Server 端口：{control.get('port', '未知')}（仅 127.0.0.1 随机端口）")
    print("- Broker 通信：文件队列；识别执行不开放网络端口")
    print(f"- 旧 local-agent：{'未使用' if values.get('local_agent') == 'NOT_USED' else '异常运行中'}")
    print(f"- 旧 command-service：{'未使用' if values.get('command_service') == 'NOT_USED' else '异常运行中'}")
    print(f"- 旧 9528 端口：{'已关闭' if values.get('port_9528') == 'CLOSED' else '仍在监听'}")
    print("- 识别方式：本地进程")
    print("- 排版命令：插件内部生成")


def prepare() -> None:
    run_step("构建本地识别组件", "npm run build:local-runtime", "本地识别组件构建完成。", timeout=240)
    run_step("安装本地识别组件", "npm run install:local-runtime", "本地识别组件已安装。")
    ensure_job_broker()
    run_step("构建 WPS 插件", "npm run build:classified", "WPS 插件构建完成。")
    run_step("检查 WPS 插件结构", "npm run verify:addin -- classified-offline", "WPS 插件结构检查已完成。")
    run_step("生成 WPS 调试包", "pwsh -NoProfile -File scripts/prepare-wps-debug-package.ps1", "WPS 调试包已生成。")


def control_manifest_path() -> Path:
    root = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    if not root:
        raise StepFailed("检查 WPS Control Server", "LOCALAPPDATA/APPDATA", "CONTROL_SERVER_APPDATA_UNAVAILABLE")
    return Path(root) / "DocxToolWps" / "control" / "endpoint.json"


def control_server_health() -> Dict[str, object]:
    manifest_path = control_manifest_path()
    manifest = read_json(manifest_path)
    base_url = str(manifest.get("base_url", ""))
    token = str(manifest.get("session_token", ""))
    port = manifest.get("port")
    heartbeat = manifest.get("heartbeat_at")
    if not base_url or not token or manifest.get("host") != "127.0.0.1" or not isinstance(port, int) or port == 9528:
        return {}
    if not isinstance(manifest.get("pid"), int) or not isinstance(manifest.get("instance_id"), str) or not isinstance(manifest.get("process_created_at"), str) or not isinstance(manifest.get("server_version"), str) or manifest.get("contract_version") != 1:
        return {}
    if not process_is_alive(manifest.get("pid")):
        return {}
    metadata = process_metadata(manifest.get("pid"))
    if metadata and not timestamps_match(metadata.get("process_created_at"), manifest.get("process_created_at")):
        return {}
    try:
        heartbeat_time = datetime.fromisoformat(str(heartbeat).replace("Z", "+00:00"))
        if (datetime.now(timezone.utc) - heartbeat_time).total_seconds() > 10:
            return {}
        endpoint = urllib.parse.urlsplit(base_url)
        if endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or endpoint.port != port:
            return {}
        request = urllib.request.Request(
            base_url.rstrip("/") + "/v1/health",
            headers={"Authorization": "Bearer " + token, "Host": "127.0.0.1"},
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            value = json.loads(response.read().decode("utf-8"))
        if not isinstance(value, dict) or value.get("status") != "ready":
            return {}
        if value.get("pid") != manifest.get("pid") or value.get("instance_id") != manifest.get("instance_id") or value.get("server_version") != manifest.get("server_version") or value.get("contract_version") != manifest.get("contract_version") or value.get("process_created_at") != manifest.get("process_created_at"):
            return {}
        return {**value, "port": port, "manifest_path": str(manifest_path), "instance_id": manifest.get("instance_id", "")}
    except (OSError, ValueError, TypeError, urllib.error.URLError):
        return {}


def ensure_control_server() -> Dict[str, object]:
    manifest_path = control_manifest_path()
    healthy = control_server_health()
    if healthy:
        previous = read_json(CONTROL_SERVER_PROCESS)
        if previous.get("pid") == healthy.get("pid") and str(previous.get("manifest_path", "")) == str(manifest_path):
            CONTROL_SERVER_PROCESS.write_text(json.dumps({"pid": healthy.get("pid"), "manifest_path": str(manifest_path), "started_at": healthy.get("heartbeat_at", ""), "process_created_at": healthy.get("process_created_at", ""), "instance_id": healthy.get("instance_id", "")}, ensure_ascii=False, indent=2), encoding="utf-8")
        log_event("INFO", "control_server.reused", "WPS 控制服务已复用", {"result_cn": "成功", "technical_detail": f"127.0.0.1:{healthy.get('port')}"})
        return healthy
    metadata = read_json(CONTROL_SERVER_PROCESS)
    process_id = metadata.get("pid")
    if process_id and process_is_alive(process_id):
        # Do not terminate an unknown process merely because the manifest is
        # stale.  Only a process recorded by this launcher can be replaced.
        if str(metadata.get("manifest_path", "")) == str(manifest_path) and managed_control_server_process(process_id, manifest_path, metadata.get("process_created_at")):
            try:
                subprocess.run(["taskkill", "/PID", str(int(process_id)), "/T", "/F"], cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            except (OSError, ValueError):
                pass
            time.sleep(0.2)
    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    log_event("INFO", "control_server.start", "开始启动 WPS 控制服务", {"stage_cn": "启动本地控制服务"})
    process = subprocess.Popen(
        [sys.executable, str(ROOT / "control-server" / "run.py"), "start", "--manifest", str(manifest_path), "--port", "0"],
        cwd=str(ROOT),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
        close_fds=True,
    )
    CONTROL_SERVER_PROCESS.parent.mkdir(parents=True, exist_ok=True)
    CONTROL_SERVER_PROCESS.write_text(json.dumps({"pid": process.pid, "manifest_path": str(manifest_path), "started_at": utc_now(), "process_created_at": process_metadata(process.pid).get("process_created_at", "")}, ensure_ascii=False, indent=2), encoding="utf-8")
    for _ in range(40):
        time.sleep(0.1)
        healthy = control_server_health()
        if healthy:
            CONTROL_SERVER_PROCESS.write_text(json.dumps({"pid": healthy.get("pid"), "manifest_path": str(manifest_path), "started_at": healthy.get("heartbeat_at", ""), "process_created_at": healthy.get("process_created_at", ""), "instance_id": healthy.get("instance_id", "")}, ensure_ascii=False, indent=2), encoding="utf-8")
            log_event("INFO", "control_server.ready", "WPS 控制服务已就绪", {"result_cn": "成功", "technical_detail": f"127.0.0.1:{healthy.get('port')}"})
            return healthy
        if process.poll() is not None:
            raise StepFailed("启动 WPS Control Server", "control-server/run.py", "CONTROL_SERVER_EXITED")
    raise StepFailed("启动 WPS Control Server", "control-server/run.py", "CONTROL_SERVER_READY_TIMEOUT")


def stop_control_server() -> None:
    metadata = read_json(CONTROL_SERVER_PROCESS)
    process_id = metadata.get("pid")
    manifest_path = control_manifest_path()
    if process_id and process_is_alive(process_id) and str(metadata.get("manifest_path", "")) == str(manifest_path) and managed_control_server_process(process_id, manifest_path, metadata.get("process_created_at")):
        try:
            subprocess.run(["taskkill", "/PID", str(int(process_id)), "/T", "/F"], cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        except (OSError, ValueError):
            pass
    try:
        CONTROL_SERVER_PROCESS.unlink()
    except FileNotFoundError:
        pass


def is_port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def read_json(path: Path) -> Dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def appdata_docxtool_root() -> Path:
    value = os.environ.get("APPDATA")
    if not value:
        raise StepFailed("检查本地任务 Broker", "APPDATA", "APPDATA_UNAVAILABLE")
    return Path(value) / "Docxtool"


def broker_current() -> Dict[str, object]:
    return read_json(appdata_docxtool_root() / "runtime" / "current.json")


def broker_status() -> Dict[str, object]:
    return read_json(appdata_docxtool_root() / "broker" / "status.json")


def process_is_alive(pid: object) -> bool:
    try:
        process_id = int(pid)
        if process_id <= 0:
            return False
        if sys.platform == "win32":
            result = subprocess.run(["pwsh", "-NoProfile", "-Command", f"Get-Process -Id {process_id} -ErrorAction SilentlyContinue | Out-Null"], cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            return result.returncode == 0
        os.kill(process_id, 0)
        return True
    except (OSError, SystemError, TypeError, ValueError):
        return False


def process_metadata(pid: object) -> Dict[str, object]:
    if not process_is_alive(pid):
        return {}
    script = f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}'; if($p){{[pscustomobject]@{{pid=$p.ProcessId; executable_path=$p.ExecutablePath; command_line=$p.CommandLine; process_created_at=$p.CreationDate.ToUniversalTime().ToString('o')}}|ConvertTo-Json -Compress}}"
    try:
        output = subprocess.check_output(["pwsh", "-NoProfile", "-Command", script], cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", timeout=10)
        value = json.loads(output) if output.strip() else {}
        return value if isinstance(value, dict) else {}
    except (OSError, subprocess.SubprocessError, ValueError, json.JSONDecodeError):
        return {}


def timestamps_match(left: object, right: object) -> bool:
    try:
        first = datetime.fromisoformat(str(left).replace("Z", "+00:00")).astimezone(timezone.utc)
        second = datetime.fromisoformat(str(right).replace("Z", "+00:00")).astimezone(timezone.utc)
        return abs((first - second).total_seconds()) <= 2
    except (TypeError, ValueError, OverflowError):
        return False


def managed_control_server_process(pid: object, manifest_path: Path, expected_created_at: object = None) -> bool:
    value = process_metadata(pid)
    if not value:
        return False
    command_line = str(value.get("command_line", "")).lower().replace("/", "\\")
    expected_launcher = str(ROOT / "control-server" / "run.py").lower().replace("/", "\\")
    expected_manifest = str(manifest_path).lower().replace("/", "\\")
    if expected_launcher not in command_line or expected_manifest not in command_line:
        return False
    return expected_created_at is not None and timestamps_match(value.get("process_created_at"), expected_created_at)


def managed_broker_process(pid: object, executable: Path, expected_created_at: object = None) -> bool:
    value = process_metadata(pid)
    if not value:
        return False
    if str(value.get("executable_path", "")).lower() != str(executable).lower():
        return False
    if "docxtool-job-broker" not in str(value.get("command_line", "")).lower():
        return False
    return expected_created_at is not None and timestamps_match(value.get("process_created_at"), expected_created_at)


def broker_healthy(current: Dict[str, object], status: Dict[str, object]) -> bool:
    heartbeat = status.get("heartbeat_at")
    if status.get("state") not in {"READY", "RUNNING"} or not isinstance(heartbeat, str):
        return False
    try:
        heartbeat_ms = calendar.timegm(time.strptime(heartbeat[:19], "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, OverflowError):
        return False
    if time.time() - heartbeat_ms > 3:
        return False
    if not status.get("broker_instance_id") or not status.get("process_created_at"):
        return False
    if status.get("broker_version") != current.get("broker_version"):
        return False
    if status.get("broker_executable_path_hash") != current.get("broker_executable_path_hash"):
        return False
    if status.get("broker_executable_sha256") != current.get("broker_sha256"):
        return False
    if status.get("queue_contract_version") != current.get("queue_contract_version", current.get("broker_contract_version")):
        return False
    if status.get("contract_version") != current.get("contract_version"):
        return False
    if status.get("runtime_version") != current.get("runtime_version") or status.get("runtime_sha256") != current.get("executable_sha256"):
        return False
    return managed_broker_process(status.get("pid"), Path(str(current.get("broker_executable_path", ""))), status.get("process_created_at"))


def stop_job_broker() -> None:
    current = broker_current()
    executable = Path(str(current.get("broker_executable_path", "")))
    metadata = read_json(JOB_BROKER_PROCESS)
    pid = metadata.get("pid")
    if not pid or not managed_broker_process(pid, executable, metadata.get("process_created_at")):
        return
    subprocess.run(["pwsh", "-NoProfile", "-Command", "Stop-Process", "-Id", str(int(pid))], cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    for _ in range(20):
        if not process_is_alive(pid):
            break
        time.sleep(0.1)
    try:
        JOB_BROKER_PROCESS.unlink()
    except FileNotFoundError:
        pass


def ensure_job_broker() -> Dict[str, object]:
    current = broker_current()
    executable_value = current.get("broker_executable_path")
    if not isinstance(executable_value, str) or not executable_value:
        raise StepFailed("启动本地任务 Broker", "runtime current.json", "LOCAL_JOB_BROKER_NOT_FOUND")
    executable = Path(executable_value)
    if not executable.is_file():
        raise StepFailed("启动本地任务 Broker", "docxtool-job-broker.exe", "LOCAL_JOB_BROKER_NOT_FOUND")
    expected_hash = str(current.get("broker_sha256", "")).lower()
    if not expected_hash or hashlib.sha256(executable.read_bytes()).hexdigest().lower() != expected_hash:
        raise StepFailed("启动本地任务 Broker", "docxtool-job-broker.exe", "LOCAL_JOB_BROKER_SHA256_MISMATCH")
    status = broker_status()
    if broker_healthy(current, status):
        JOB_BROKER_PROCESS.parent.mkdir(parents=True, exist_ok=True)
        JOB_BROKER_PROCESS.write_text(json.dumps({"pid": status.get("pid"), "executable": str(executable), "runtime_version": current.get("runtime_version"), "runtime_sha256": current.get("executable_sha256"), "started_at": status.get("started_at", ""), "process_created_at": status.get("process_created_at", ""), "broker_instance_id": status.get("broker_instance_id", "")}, ensure_ascii=False, indent=2), encoding="utf-8")
        log_event("INFO", "broker.reused", "本地任务代理已复用", {"result_cn": "成功", "technical_detail": f"PID {status.get('pid')}"})
        return status
    stale_pid = status.get("pid")
    if stale_pid and process_is_alive(stale_pid) and not managed_broker_process(stale_pid, executable, status.get("process_created_at")):
        raise StepFailed("启动本地任务 Broker", "Broker 身份校验", "LOCAL_JOB_BROKER_IDENTITY_MISMATCH")
    if stale_pid and managed_broker_process(stale_pid, executable, status.get("process_created_at")):
        subprocess.run(["pwsh", "-NoProfile", "-Command", "Stop-Process", "-Id", str(int(stale_pid))], cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    log_event("INFO", "broker.start", "开始启动本地任务代理", {"stage_cn": "启动本地任务代理"})
    process = subprocess.Popen([str(executable), "run", "--log-path", str(WPS_LOG)], cwd=str(ROOT), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags, close_fds=True)
    JOB_BROKER_PROCESS.parent.mkdir(parents=True, exist_ok=True)
    JOB_BROKER_PROCESS.write_text(json.dumps({"pid": process.pid, "executable": str(executable), "runtime_version": current.get("runtime_version"), "runtime_sha256": current.get("executable_sha256"), "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "process_created_at": process_metadata(process.pid).get("process_created_at", "")}, ensure_ascii=False, indent=2), encoding="utf-8")
    for _ in range(50):
        time.sleep(0.1)
        status = broker_status()
        if broker_healthy(current, status):
            JOB_BROKER_PROCESS.write_text(json.dumps({"pid": status.get("pid"), "executable": str(executable), "runtime_version": current.get("runtime_version"), "runtime_sha256": current.get("executable_sha256"), "started_at": status.get("started_at", ""), "process_created_at": status.get("process_created_at", ""), "broker_instance_id": status.get("broker_instance_id", "")}, ensure_ascii=False, indent=2), encoding="utf-8")
            log_event("INFO", "broker.ready", "本地任务代理已就绪", {"result_cn": "成功", "technical_detail": f"PID {status.get('pid')}"})
            return status
        if process.poll() is not None:
            raise StepFailed("启动本地任务 Broker", "docxtool-job-broker.exe", "LOCAL_JOB_BROKER_EXITED")
    raise StepFailed("启动本地任务 Broker", "docxtool-job-broker.exe", "LOCAL_JOB_BROKER_READY_TIMEOUT")


def fetch_resource(relative: str) -> Dict[str, object]:
    url = f"http://127.0.0.1:{WPSJS_PORT}/{relative.lstrip('/')}"
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            content = response.read()
            return {"path": relative, "status": int(response.status), "content_type": response.headers.get("Content-Type", ""), "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(), "text": content.decode("utf-8", errors="replace")}
    except (OSError, urllib.error.URLError) as error:
        return {"path": relative, "status": 0, "error": str(error), "text": ""}


def probe_debug_server() -> Dict[str, object]:
    manifest = read_json(DEBUG_MANIFEST)
    required = ["index.html", "main.js", "ribbon.xml", "js/bootstrap-probe.js", "js/ribbon.js", "host-runtime.js", "pipeline-worker-probe.js", "pipeline-worker.js", "ui/build-info.js", "ui/local-runtime-config.js", "ui/default-format-profile.js", "ui/taskpane.html"]
    resources = {path: fetch_resource(path) for path in required}
    errors: List[str] = []
    for path, item in resources.items():
        if item.get("status") != 200:
            errors.append(f"RESOURCE_UNAVAILABLE:{path}")
    main_text = str(resources["main.js"].get("text", "")); ribbon_text = str(resources["js/ribbon.js"].get("text", "")); host_text = str(resources["host-runtime.js"].get("text", "")); build_text = str(resources["ui/build-info.js"].get("text", ""))
    if not all(marker in main_text for marker in ("js/bootstrap-probe.js", "js/ribbon.js", "host-runtime.js")) or "type='module'" in main_text or "dist/host-runtime.js" in main_text: errors.append("MAIN_ENTRY_MISMATCH")
    if not all(marker in ribbon_text for marker in ("DocxtoolRunLocalCommand", "window.OnAction", "ribbon.action.received")) or "DocxtoolHostEnqueue" in ribbon_text: errors.append("RIBBON_ENTRY_MISMATCH")
    if not all(marker in host_text for marker in ("host.module.loaded", "DocxtoolRunLocalCommand", "pipeline.worker.probe.start")) or "import(" in host_text: errors.append("LOCAL_RUNTIME_BUNDLE_MISMATCH")
    expected_build = str(manifest.get("build_id", ""))
    if expected_build and expected_build not in build_text: errors.append("BUILD_ID_MISMATCH")
    critical = manifest.get("critical_assets", {}) if isinstance(manifest.get("critical_assets"), dict) else {}
    for path, expected_hash in critical.items():
        if resources.get(str(path), {}).get("sha256") != expected_hash: errors.append(f"ASSET_HASH_MISMATCH:{path}")
    report: Dict[str, object] = {"schema_version": 1, "expected_build_id": expected_build, "served_build_id": expected_build if not errors else "", "status": "PASS" if not errors else "FAIL", "errors": errors, "resources": [{key: value for key, value in item.items() if key != "text"} for item in resources.values()]}
    RESOURCE_PROBE.parent.mkdir(parents=True, exist_ok=True); RESOURCE_PROBE.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def write_process_metadata(process: subprocess.Popen[bytes], manifest: Dict[str, object], command: List[str]) -> None:
    WPSJS_PROCESS.parent.mkdir(parents=True, exist_ok=True)
    WPSJS_PROCESS.write_text(json.dumps({"pid": process.pid, "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "cwd": str(DEBUG_PACKAGE), "expected_build_id": manifest.get("build_id", ""), "port": WPSJS_PORT, "command": command}, ensure_ascii=False, indent=2), encoding="utf-8")


def port_owner_info() -> Dict[str, object]:
    script = f"$c=Get-NetTCPConnection -LocalPort {WPSJS_PORT} -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1;if($c){{$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c.OwningProcess);[pscustomobject]@{{pid=$c.OwningProcess;name=$p.Name;command_line=$p.CommandLine}}|ConvertTo-Json -Compress}}"
    try:
        output = subprocess.check_output(["pwsh", "-NoProfile", "-Command", script], cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", timeout=10).strip()
        value = json.loads(output) if output else {}
        return value if isinstance(value, dict) else {}
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}


def update_server_owner_metadata() -> None:
    value = read_json(WPSJS_PROCESS); value["server_process"] = port_owner_info()
    WPSJS_PROCESS.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def register_addin() -> None:
    if is_port_open(WPSJS_PORT):
        report = probe_debug_server()
        metadata = read_json(WPSJS_PROCESS)
        owner = port_owner_info()
        command_line = str(owner.get("command_line", ""))
        # The launcher process can exit after creating a child on Windows, so
        # the port owner PID is not required to equal the recorded Popen PID.
        # The package directory and command kind are the safety boundary.
        managed_owner = Path(str(metadata.get("cwd", ""))).resolve() == DEBUG_PACKAGE.resolve() and bool(owner.get("pid")) and str(DEBUG_PACKAGE) in command_line
        if report.get("status") == "PASS" and managed_owner and "wps_debug_server.py" in command_line:
            metadata["expected_build_id"] = read_json(DEBUG_MANIFEST).get("build_id", "")
            WPSJS_PROCESS.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
            log_event("INFO", "debug_server.reused", "WPS 资源服务已验证并复用", {"result_cn": "成功"})
            return
        if managed_owner and ("wps_debug_server.py" in command_line or "http.server" in command_line):
            pid = str(owner.get("pid", ""))
            if pid.isdigit():
                subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                for _ in range(20):
                    if not is_port_open(WPSJS_PORT):
                        break
                    time.sleep(0.25)
        if is_port_open(WPSJS_PORT):
            raise StepFailed("启动 WPS 调试服务", "wps_debug_server.py", "WPSJS_PORT_OCCUPIED_BY_UNMANAGED_PROCESS")

    if not DEBUG_MANIFEST.exists():
        raise StepFailed("启动 WPS 调试服务", "wpsjs debug -s", "WPS_DEBUG_PACKAGE_MISSING")
    registration_raw = run_command("pwsh -NoProfile -File scripts/inspect-wps-registration.ps1", timeout=30)
    registration_value = json.loads(registration_raw)
    if not registration_value.get("registration_matches_current_server"):
        raise StepFailed("检查 WPS 注册信息", "inspect-wps-registration.ps1", "WPS_REGISTRATION_MISMATCH")
    log_event("INFO", "debug_server.start", "开始启动 WPS 资源服务", {"stage_cn": "启动本地资源服务"})
    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    command = [sys.executable, "-u", str(ROOT / "scripts" / "wps_debug_server.py"), "--root", str(DEBUG_PACKAGE), "--port", str(WPSJS_PORT), "--log", str(WPS_LOG)]
    process = subprocess.Popen(
        command,
        cwd=str(DEBUG_PACKAGE),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )
    write_process_metadata(process, read_json(DEBUG_MANIFEST), command)
    for _ in range(30):
        if is_port_open(WPSJS_PORT):
            report = probe_debug_server()
            if report.get("status") != "PASS":
                raise StepFailed("验证 WPS 调试资源", "HTTP resource probe", ",".join(str(item) for item in report.get("errors", [])))
            update_server_owner_metadata()
            log_event("INFO", "debug_server.ready", "WPS 资源服务已就绪", {"result_cn": "成功"})
            log_event("INFO", "addin.registration.ready", "WPS 加载项注册已就绪", {"result_cn": "成功"})
            return
        if process.poll() is not None:
            raise StepFailed("注册 WPS 插件项目", "wps_debug_server.py", "WPS 插件服务启动后立即退出。")
        time.sleep(0.5)
    raise StepFailed("启动 WPS 调试服务", "wps_debug_server.py", f"等待端口 {WPSJS_PORT} 就绪超时。")


def verify() -> None:
    ensure_job_broker()
    run_step("执行 WPS 本地直连功能检测", "npm run verify:local-direct", "WPS 功能检测已完成。", timeout=240)


def diagnostic_events() -> List[Dict[str, object]]:
    current_build = str(read_json(DEBUG_MANIFEST).get("build_id", ""))
    events = read_log_events(WPS_LOG)
    return [item for item in events if not current_build or not item.get("build_id") or item.get("build_id") == current_build]


def plugin_page_loaded(event_names: List[str]) -> bool:
    return any(name in event_names for name in ("bootstrap.probe.loaded", "ribbon.script.loaded", "host.module.loaded"))


def diagnose() -> None:
    resource = probe_debug_server() if is_port_open(WPSJS_PORT) else {"status": "FAIL", "errors": ["DEBUG_SERVER_NOT_RUNNING"]}
    registration_raw = run_command("pwsh -NoProfile -File scripts/inspect-wps-registration.ps1", timeout=30)
    registration = json.loads(registration_raw)
    events = diagnostic_events(); names = [str(item.get("event", "")) for item in events]
    checks = [
        ("WPS资源服务", resource.get("status") == "PASS"),
        ("WPS注册配置", bool(registration.get("registration_matches_current_server"))),
        ("插件页面", plugin_page_loaded(names)),
        ("功能区脚本", "ribbon.script.loaded" in names),
        ("功能区回调", "ribbon.addin.load.success" in names),
        ("WPS宿主运行时", "application.install.success" in names),
    ]
    print("WPS 装载诊断：")
    for label, passed in checks: print(f"- {label}：{'正常' if passed else '等待'}")
    last_action = next((item for item in reversed(events) if item.get("event") == "ribbon.action.received"), None)
    last_error = next((item for item in reversed(events) if item.get("level") in ("错误", "致命")), None)
    print(f"- 最近一次按钮操作：{last_action.get('timestamp') if last_action else '无'}")
    print(f"- 最近错误：{last_error.get('message') if last_error else '无'}")
    if not plugin_page_loaded(names):
        print("WPS 尚未加载当前插件页面。请保存文档并完全关闭全部 WPS 进程后重新打开。")


def wps_is_running() -> bool:
    try:
        output = subprocess.check_output(["pwsh", "-NoProfile", "-Command", "@(Get-Process wps -ErrorAction SilentlyContinue).Count"], cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", timeout=10)
        return int(output.strip() or "0") > 0
    except (OSError, subprocess.SubprocessError, ValueError):
        return False


def watch_wps_log() -> None:
    print(f"WPS 统一日志：{WPS_LOG}", flush=True)
    print("正在等待 WPS 操作日志；按 Ctrl+C 停止监视。", flush=True)
    positions = {path: path.stat().st_size if path.exists() else 0 for path in (WPS_LOG,)}
    last_fingerprint = ""
    suppressed_repeats = 0
    try:
        while True:
            for path in positions:
                if not path.exists(): continue
                size = path.stat().st_size
                if size < positions[path]: positions[path] = 0
                with path.open("r", encoding="utf-8", errors="replace") as handle:
                    handle.seek(positions[path])
                    for line in handle:
                        rendered = line.strip()
                        if not rendered:
                            continue
                        fingerprint = rendered
                        if fingerprint == last_fingerprint:
                            suppressed_repeats += 1
                            continue
                        if suppressed_repeats:
                            print(f"重复日志已抑制 {suppressed_repeats} 次。", flush=True)
                            suppressed_repeats = 0
                        last_fingerprint = fingerprint
                        print(rendered, flush=True)
                    positions[path] = handle.tell()
            time.sleep(0.5)
    except KeyboardInterrupt:
        if suppressed_repeats:
            print(f"[提示] 上一条相同日志重复 {suppressed_repeats} 次，已自动省略。", flush=True)
        print("已停止日志监视；WPS 加载项服务继续在后台运行。", flush=True)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Docxtool WPS 本地直连启动入口")
    parser.add_argument(
        "action",
        nargs="?",
        default="start",
        choices=("start", "prepare", "status", "diagnose", "logs", "stop", "reset", "verify", "control-status", "control-stop"),
        help="start=完整启动；prepare=准备构建；status=查看状态；control-status/control-stop=控制服务状态；diagnose=装载诊断；logs=交互日志；verify=功能检测",
    )
    parser.add_argument("--once", action="store_true", help="启动完成后立即返回，不持续监视 WPS 日志")
    args = parser.parse_args(argv)

    print("Docxtool WPS 本地直连版", flush=True)
    print("说明：本入口启动随机 loopback WPS Control Server；不启动旧 9528/local-agent/command-service。", flush=True)
    if args.action == "start":
        log_event("INFO", "session.start", "新的 WPS 日志会话已开始", {"stage_cn": "启动 WPS 插件"})

    try:
        if args.action == "start":
            prepare()
            ensure_control_server()
            register_addin()
            verify()
            print_status()
            if wps_is_running() and not plugin_page_loaded([str(item.get("event", "")) for item in diagnostic_events()]):
                print("启动完成，但当前 WPS 尚未重新加载本次构建。请先正常保存并关闭脱敏测试文档，再完全退出 WPS 后重新打开；不要重复点击旧功能区。", flush=True)
            else:
                print("启动完成。请打开 WPS 后使用顶部功能区。", flush=True)
            if not args.once:
                watch_wps_log()
        elif args.action == "prepare":
            prepare()
            print("准备完成。", flush=True)
        elif args.action == "status":
            print_status()
        elif args.action == "verify":
            verify()
        elif args.action == "diagnose":
            diagnose()
        elif args.action == "logs":
            watch_wps_log()
        elif args.action == "stop":
            stop_control_server()
            stop_job_broker()
            run_step("停止本入口管理的开发资源", "pwsh -NoProfile -File scripts/local-direct.ps1 stop", "已停止。本操作不会关闭 WPS。")
        elif args.action == "control-status":
            value = control_server_health()
            print(json.dumps(value or {"status": "not_ready"}, ensure_ascii=False, indent=2))
            return 0 if value else 1
        elif args.action == "control-stop":
            stop_control_server()
            print("已停止本入口管理的 WPS Control Server。", flush=True)
        elif args.action == "reset":
            run_step("重置本地识别组件指针", "pwsh -NoProfile -File scripts/local-direct.ps1 reset", "本地识别组件指针已重置。")
        return 0
    except StepFailed as error:
        log_event("ERROR", "launcher.failed", "WPS 启动流程未完成", {"stage_cn": error.title, "reason_cn": "当前启动步骤失败", "action_cn": "查看统一日志中的错误码并修复后重试", "technical_detail": useful_error(error.output)}, error)
        print("处理未完成。请查看 wps-plugin.log 中的中文错误继续排查。", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
