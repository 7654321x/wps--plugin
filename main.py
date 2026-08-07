from __future__ import annotations

import argparse
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
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

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
LOCAL_RUNTIME_MANIFEST = ROOT / "dist" / "local-runtime" / "win-x64" / "runtime-manifest.json"
WPSJS_PROCESS = ROOT / ".runtime" / "wpsjs-debug-process.json"
RESOURCE_PROBE = ROOT / ".runtime" / "resource-probe.json"
JOB_BROKER_PROCESS = ROOT / ".runtime" / "local-job-broker-process.json"
CONTROL_SERVER_PROCESS = ROOT / ".runtime" / "control-server-process.json"
BROKER_READY_TIMEOUT_SECONDS = 10.0
BROKER_HEARTBEAT_MAX_AGE_SECONDS = 3.0
PROCESS_METADATA_TIMEOUT_SECONDS = 2.0
BROKER_SWITCH_ERROR_CODES = {
    "LOCAL_JOB_BROKER_VERSION_MISMATCH",
    "LOCAL_JOB_BROKER_EXECUTABLE_HASH_MISMATCH",
    "LOCAL_JOB_BROKER_RUNTIME_VERSION_MISMATCH",
    "LOCAL_JOB_BROKER_RUNTIME_HASH_MISMATCH",
}


@dataclass(frozen=True)
class BrokerReadiness:
    ready: bool
    error_code: Optional[str]
    reason_cn: str
    action_cn: str
    details: Dict[str, object]


@dataclass(frozen=True)
class ProcessMetadataResult:
    metadata: Dict[str, object]
    state: str
    detail: str = ""


def log_event(level: str, event: str, message: str, data: Optional[Dict[str, object]] = None, error: object = None, *, component: str = "main") -> None:
    event_value: Dict[str, object] = {
        "timestamp": utc_now(),
        "level": level,
        "component": component,
        "event": event,
        "message": message,
        "data": data or {},
    }
    if error is not None:
        event_value["error"] = {"name": type(error).__name__, "message": str(error)}
    for line in LOG_WRITER.append([event_value]):
        print(line, flush=True)


class StepFailed(RuntimeError):
    def __init__(
        self,
        title: str,
        command: str,
        output: str,
        *,
        reason_cn: str = "",
        action_cn: str = "",
        error_code: str = "",
        details: Optional[Dict[str, object]] = None,
    ) -> None:
        self.title = title
        self.command = command
        self.output = output
        self.reason_cn = reason_cn
        self.action_cn = action_cn
        self.error_code = error_code
        self.details = details or {}
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


def print_status(*, startup: bool = False, watch_logs: bool = False) -> None:
    output = run_command("pwsh -NoProfile -File scripts/local-direct.ps1 status", timeout=60)
    values = parse_status(output)
    server_ready = is_port_open(WPSJS_PORT) and probe_debug_server().get("status") == "PASS"
    event_names = [str(item.get("event", "")) for item in diagnostic_events()]
    page_loaded = plugin_page_loaded(event_names)
    current = broker_current()
    status, status_error = read_broker_status(appdata_docxtool_root() / "broker" / "status.json")
    broker_check = status_error or broker_readiness(current, status)
    control = control_server_health()
    product_version = read_json(ROOT / "package.json").get("version", "未知")
    lines = [
        f"版本与插件：产品 v{product_version}；提交 {values.get('repository_head', '未知')}；构建{'已生成' if values.get('plugin_build') == 'READY' else '未生成'}；页面{'已加载' if page_loaded else '等待 WPS 重新加载'}",
        f"资源与注册：资源服务{'已验证' if server_ready else '未就绪'}；WPS 注册{'已登记' if values.get('plugin_registration') else '未确认'}",
        f"本地识别：组件{'已安装' if values.get('local_runtime') == 'READY' else '未安装'}；识别程序{'存在' if values.get('runtime_executable_exists') == 'YES' else '不存在'}；Broker {'已就绪' if broker_check.ready else '未就绪'}（PID {status.get('pid', '未知')}，版本 {status.get('broker_version', '未知')}）",
        f"控制服务：{'已就绪' if control.get('status') == 'ready' else '未就绪'}（127.0.0.1:{control.get('port', '未知')}）；Broker 使用文件队列，识别执行不开放网络端口",
        f"旧链路：local-agent {'未使用' if values.get('local_agent') == 'NOT_USED' else '异常运行中'}；command-service {'未使用' if values.get('command_service') == 'NOT_USED' else '异常运行中'}；9528 端口{'已关闭' if values.get('port_9528') == 'CLOSED' else '仍在监听'}",
        "执行方式：识别由本地进程执行；排版命令由插件内部生成",
    ]
    if not broker_check.ready:
        lines.append(f"Broker 失败：{broker_check.reason_cn}；错误码 {broker_check.error_code}；建议 {broker_check.action_cn}")
        detail = readiness_technical_detail(broker_check)
        if detail:
            lines.append(f"Broker 诊断：{detail}")
    if startup:
        if wps_is_running() and not page_loaded:
            lines.append("下一步：当前 WPS 尚未重新加载本次构建；保存并关闭当前文档，完全退出 WPS 后重新打开，不要继续点击旧功能区")
        else:
            lines.append("下一步：打开 WPS 后使用顶部功能区")
    if watch_logs:
        lines.append("统一日志：wps-plugin.log；正在等待 WPS 操作，按 Ctrl+C 停止监视")
    log_event("INFO", "launcher.status.summary", "WPS 启动状态汇总" if startup else "WPS 当前状态汇总", {"result_cn": "成功", "summary_lines": lines})


def prepare(*, rebuild_runtime: bool = True) -> None:
    if rebuild_runtime or not local_runtime_matches_build():
        run_step("构建本地识别组件", "npm run build:local-runtime", "本地识别组件构建完成。", timeout=240)
        run_step("安装本地识别组件", "npm run install:local-runtime", "本地识别组件已安装。")
    else:
        current = broker_current()
        log_event(
            "INFO",
            "broker.runtime.reused",
            "已复用已安装的本地识别组件，跳过 runtime 重建",
            {"result_cn": "成功", "runtime_version": current.get("runtime_version")},
        )
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


def broker_failure(code: str, reason_cn: str, action_cn: str, details: Optional[Dict[str, object]] = None) -> BrokerReadiness:
    return BrokerReadiness(False, code, reason_cn, action_cn, details or {})


def broker_ready() -> BrokerReadiness:
    return BrokerReadiness(True, None, "", "", {})


def read_broker_status(path: Path) -> Tuple[Dict[str, object], Optional[BrokerReadiness]]:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}, broker_failure(
            "LOCAL_JOB_BROKER_STATUS_MISSING",
            "Broker 状态文件尚未生成",
            "检查 Broker 是否已启动，并查看统一日志中的 Broker 启动事件",
            {"file": path.name},
        )
    except (OSError, UnicodeError) as error:
        return {}, broker_failure(
            "LOCAL_JOB_BROKER_STATUS_INVALID",
            "Broker 状态文件无法读取",
            "检查状态文件权限和本地 runtime 安装状态后重试",
            {"file": path.name, "error_type": type(error).__name__},
        )
    if not raw.strip():
        return {}, broker_failure(
            "LOCAL_JOB_BROKER_STATUS_INVALID",
            "Broker 状态文件为空，内容尚未完整写入",
            "等待 Broker 完成启动；若持续出现，请重新安装本地识别组件",
            {"file": path.name},
        )
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        return {}, broker_failure(
            "LOCAL_JOB_BROKER_STATUS_INVALID",
            "Broker 状态文件不是有效 JSON",
            "停止旧 Broker 后重新启动本地识别组件",
            {"file": path.name, "line": error.lineno, "column": error.colno},
        )
    if not isinstance(value, dict):
        return {}, broker_failure(
            "LOCAL_JOB_BROKER_STATUS_INVALID",
            "Broker 状态文件根节点不是对象",
            "重新安装本地识别组件后重试",
            {"file": path.name, "root_type": type(value).__name__},
        )
    return value, None


def appdata_docxtool_root() -> Path:
    value = os.environ.get("APPDATA")
    if not value:
        raise StepFailed("检查本地任务 Broker", "APPDATA", "APPDATA_UNAVAILABLE")
    return Path(value) / "Docxtool"


def broker_current() -> Dict[str, object]:
    return read_json(appdata_docxtool_root() / "runtime" / "current.json")


def local_runtime_matches_build() -> bool:
    manifest = read_json(LOCAL_RUNTIME_MANIFEST)
    current = broker_current()
    if not manifest or not current:
        return False
    for key in (
        "contract_version",
        "runtime_version",
        "executable_sha256",
        "broker_version",
        "broker_sha256",
        "broker_contract_version",
        "queue_contract_version",
        "recognition_package_version",
    ):
        if current.get(key) != manifest.get(key):
            return False
    if Path(str(current.get("executable_path", ""))).name != str(manifest.get("executable", "")):
        return False
    if Path(str(current.get("broker_executable_path", ""))).name != str(manifest.get("broker_executable", "")):
        return False
    return Path(str(current.get("executable_path", ""))).is_file() and Path(str(current.get("broker_executable_path", ""))).is_file()


def broker_status() -> Dict[str, object]:
    status, _ = read_broker_status(appdata_docxtool_root() / "broker" / "status.json")
    return status


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


def query_process_metadata(pid: object) -> ProcessMetadataResult:
    try:
        process_id = int(pid)
    except (TypeError, ValueError):
        return ProcessMetadataResult({}, "not_running", "PID 无效")
    if process_id <= 0:
        return ProcessMetadataResult({}, "not_running", "PID 无效")
    if sys.platform != "win32":
        try:
            os.kill(process_id, 0)
        except ProcessLookupError:
            return ProcessMetadataResult({}, "not_running", "进程不存在")
        except OSError as error:
            return ProcessMetadataResult({}, "unavailable", type(error).__name__)
        return ProcessMetadataResult({}, "unavailable", "当前平台没有受支持的进程身份查询")
    script = f"$process=Get-CimInstance Win32_Process -Filter 'ProcessId={process_id}'; if($process){{$parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+$process.ParentProcessId);[pscustomobject]@{{pid=$process.ProcessId; name=$process.Name; executable_path=$process.ExecutablePath; command_line=$process.CommandLine; parent_process_id=$process.ParentProcessId; parent_name=$parent.Name; process_created_at=$process.CreationDate.ToUniversalTime().ToString('o')}}|ConvertTo-Json -Compress}}"
    try:
        output = subprocess.check_output(
            ["pwsh", "-NoProfile", "-Command", script],
            cwd=str(ROOT),
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=PROCESS_METADATA_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return ProcessMetadataResult({}, "unavailable", "进程身份查询超时")
    except (OSError, subprocess.SubprocessError) as error:
        return ProcessMetadataResult({}, "unavailable", type(error).__name__)
    if not output.strip():
        return ProcessMetadataResult({}, "not_running", "进程不存在")
    try:
        value = json.loads(output)
    except json.JSONDecodeError as error:
        return ProcessMetadataResult({}, "unavailable", f"JSON 第 {error.lineno} 行无效")
    if not isinstance(value, dict):
        return ProcessMetadataResult({}, "unavailable", "进程查询结果不是对象")
    return ProcessMetadataResult(value, "ready")


def process_metadata(pid: object) -> Dict[str, object]:
    return query_process_metadata(pid).metadata


def parse_utc_timestamp(value: object) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip().replace("Z", "+00:00")
    if "." in normalized:
        date_part, suffix = normalized.split(".", 1)
        offset_index = len(suffix)
        for marker in ("+", "-"):
            marker_index = suffix.find(marker, 1)
            if marker_index >= 0:
                offset_index = min(offset_index, marker_index)
        fraction = suffix[:offset_index]
        if fraction:
            normalized = f"{date_part}.{fraction[:6]}{suffix[offset_index:]}"
    if len(normalized) >= 5 and normalized[-5] in ("+", "-") and normalized[-4:].isdigit():
        normalized = f"{normalized[:-2]}:{normalized[-2:]}"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def timestamps_match(left: object, right: object) -> bool:
    first = parse_utc_timestamp(left)
    second = parse_utc_timestamp(right)
    return first is not None and second is not None and abs((first - second).total_seconds()) <= 2


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


def broker_executable_path_hash(executable: Path) -> str:
    normalized = str(executable).casefold().replace("/", "\\")
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def managed_broker_process(pid: object, executable: Path, expected_created_at: object = None, expected_path_hash: object = None) -> bool:
    value = process_metadata(pid)
    if not value:
        return False
    actual_executable = str(value.get("executable_path") or "")
    if actual_executable:
        if actual_executable.casefold() != str(executable).casefold():
            return False
        if "docxtool-job-broker" not in str(value.get("command_line", "")).casefold():
            return False
    else:
        if str(value.get("name", "")).casefold() != executable.name.casefold():
            return False
        if str(value.get("parent_name", "")).casefold() != executable.name.casefold():
            return False
        if expected_path_hash != broker_executable_path_hash(executable):
            return False
    return expected_created_at is not None and timestamps_match(value.get("process_created_at"), expected_created_at)


def broker_quick_readiness(current: Dict[str, object], status: Dict[str, object], expected_pid: Optional[int] = None) -> BrokerReadiness:
    if status.get("schema_version") != 1:
        return broker_failure(
            "LOCAL_JOB_BROKER_STATUS_INVALID",
            "Broker 状态文件缺少有效的 schema 版本",
            "重新安装本地识别组件后重试",
            {"expected_schema_version": 1, "actual_schema_version": status.get("schema_version")},
        )
    if status.get("state") not in {"READY", "RUNNING"}:
        return broker_failure(
            "LOCAL_JOB_BROKER_STATE_INVALID",
            "Broker 状态不是可服务的 READY 或 RUNNING",
            "检查 Broker 启动日志；若状态为 FAILED，请先修复对应错误后重启",
            {"expected_state": "READY 或 RUNNING", "actual_state": status.get("state")},
        )
    pid = status.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return broker_failure(
            "LOCAL_JOB_BROKER_PID_MISMATCH",
            "Broker 状态文件中的 PID 无效",
            "停止旧 Broker 后重新启动本地识别组件",
            {"expected_pid": "正整数", "actual_pid": pid},
        )
    if expected_pid is not None and pid != expected_pid:
        return broker_failure(
            "LOCAL_JOB_BROKER_PID_MISMATCH",
            "Broker 状态 PID 与本次启动记录不一致",
            "停止旧 Broker 后重新启动本地识别组件",
            {"expected_pid": expected_pid, "actual_pid": pid},
        )
    process_created_at = status.get("process_created_at")
    if not isinstance(status.get("broker_instance_id"), str) or not status.get("broker_instance_id") or parse_utc_timestamp(process_created_at) is None:
        return broker_failure(
            "LOCAL_JOB_BROKER_STATUS_INVALID",
            "Broker 状态缺少有效的实例标识或进程创建时间",
            "停止旧 Broker 后重新启动本地识别组件",
            {"broker_instance_id_present": bool(status.get("broker_instance_id")), "process_created_at": process_created_at},
        )
    heartbeat = parse_utc_timestamp(status.get("heartbeat_at"))
    if heartbeat is None:
        return broker_failure(
            "LOCAL_JOB_BROKER_HEARTBEAT_INVALID",
            "Broker 状态中的心跳时间格式无效",
            "检查 Broker 统一日志和本机时间后重启本地识别组件",
            {"heartbeat_at": status.get("heartbeat_at")},
        )
    heartbeat_age = (datetime.now(timezone.utc) - heartbeat).total_seconds()
    if heartbeat_age > BROKER_HEARTBEAT_MAX_AGE_SECONDS:
        return broker_failure(
            "LOCAL_JOB_BROKER_HEARTBEAT_STALE",
            "Broker 状态文件存在，但心跳已超过允许时间",
            "检查 Broker 是否卡在初始化阶段，并查看同一日志中的 Broker 启动事件",
            {"heartbeat_age_seconds": round(heartbeat_age, 3), "max_age_seconds": BROKER_HEARTBEAT_MAX_AGE_SECONDS},
        )
    if status.get("broker_version") != current.get("broker_version"):
        return broker_failure(
            "LOCAL_JOB_BROKER_VERSION_MISMATCH",
            "Broker 版本与当前安装版本不一致",
            "停止旧 Broker 后重新启动本地识别组件",
            {"expected_version": current.get("broker_version"), "actual_version": status.get("broker_version")},
        )
    if status.get("broker_executable_path_hash") != current.get("broker_executable_path_hash"):
        return broker_failure(
            "LOCAL_JOB_BROKER_EXECUTABLE_HASH_MISMATCH",
            "Broker 可执行文件路径与当前 runtime 清单不一致",
            "重新安装本地识别组件，禁止复用旧 Broker",
            {"expected_path_hash": current.get("broker_executable_path_hash"), "actual_path_hash": status.get("broker_executable_path_hash")},
        )
    if status.get("broker_executable_sha256") != current.get("broker_sha256"):
        return broker_failure(
            "LOCAL_JOB_BROKER_EXECUTABLE_HASH_MISMATCH",
            "运行中的 Broker 文件哈希与当前 runtime 清单不一致",
            "重新构建并安装本地识别组件后重试",
            {"expected_sha256": current.get("broker_sha256"), "actual_sha256": status.get("broker_executable_sha256")},
        )
    if status.get("runtime_version") != current.get("runtime_version"):
        return broker_failure(
            "LOCAL_JOB_BROKER_RUNTIME_VERSION_MISMATCH",
            "Broker 使用的运行时版本与当前安装版本不一致",
            "停止旧 Broker 后重新启动本地识别组件",
            {"expected_runtime_version": current.get("runtime_version"), "actual_runtime_version": status.get("runtime_version")},
        )
    if status.get("runtime_sha256") != current.get("executable_sha256"):
        return broker_failure(
            "LOCAL_JOB_BROKER_RUNTIME_HASH_MISMATCH",
            "Broker 使用的识别程序哈希与当前安装版本不一致",
            "重新安装本地识别组件后重试",
            {"expected_runtime_sha256": current.get("executable_sha256"), "actual_runtime_sha256": status.get("runtime_sha256")},
        )
    expected_queue_contract = current.get("queue_contract_version", current.get("broker_contract_version"))
    if status.get("queue_contract_version") != expected_queue_contract:
        return broker_failure(
            "LOCAL_JOB_BROKER_QUEUE_CONTRACT_MISMATCH",
            "Broker 文件队列合同版本与当前 runtime 不一致",
            "重新安装本地识别组件后重试，不要回退旧服务链",
            {"expected_queue_contract": expected_queue_contract, "actual_queue_contract": status.get("queue_contract_version")},
        )
    if status.get("contract_version") != current.get("contract_version"):
        return broker_failure(
            "LOCAL_JOB_BROKER_CONTRACT_MISMATCH",
            "Broker 合同版本与当前 runtime 不一致",
            "重新安装本地识别组件后重试",
            {"expected_contract": current.get("contract_version"), "actual_contract": status.get("contract_version")},
        )
    return broker_ready()


def broker_process_readiness(current: Dict[str, object], status: Dict[str, object]) -> BrokerReadiness:
    result = query_process_metadata(status.get("pid"))
    if result.state == "not_running":
        return broker_failure(
            "LOCAL_JOB_BROKER_PROCESS_NOT_RUNNING",
            "Broker 状态已通过文件校验，但对应进程已经退出",
            "检查 Broker 统一日志中的退出原因后重新启动",
            {"pid": status.get("pid")},
        )
    if result.state != "ready":
        return broker_failure(
            "LOCAL_JOB_BROKER_PROCESS_METADATA_UNAVAILABLE",
            "无法读取 Broker 进程身份信息",
            "检查 PowerShell/CIM 进程查询权限后重试；不要跳过进程身份校验",
            {"pid": status.get("pid"), "query_state": result.state, "query_detail": result.detail},
        )
    metadata = result.metadata
    executable = Path(str(current.get("broker_executable_path", "")))
    actual_executable = str(metadata.get("executable_path") or "")
    if actual_executable:
        if actual_executable.casefold().replace("/", "\\") != str(executable).casefold().replace("/", "\\"):
            return broker_failure(
                "LOCAL_JOB_BROKER_EXECUTABLE_IDENTITY_MISMATCH",
                "Broker PID 对应的可执行文件不是当前受信 runtime",
                "停止旧 Broker 后重新安装并启动当前 runtime",
                {"expected_executable_name": executable.name, "actual_executable_name": Path(actual_executable).name},
            )
        command_line = str(metadata.get("command_line", ""))
        if "docxtool-job-broker" not in command_line.casefold():
            return broker_failure(
                "LOCAL_JOB_BROKER_COMMAND_LINE_MISMATCH",
                "Broker PID 对应的命令行不是受信任的 Broker 启动命令",
                "停止该进程后重新启动当前本地任务代理",
                {"pid": status.get("pid"), "broker_command_marker_present": False},
            )
    elif (
        str(metadata.get("name", "")).casefold() != executable.name.casefold()
        or str(metadata.get("parent_name", "")).casefold() != executable.name.casefold()
        or current.get("broker_executable_path_hash") != broker_executable_path_hash(executable)
    ):
        return broker_failure(
            "LOCAL_JOB_BROKER_EXECUTABLE_IDENTITY_MISMATCH",
            "PyInstaller Broker 的路径信息不可见，且无法用受信启动树证明其身份",
            "停止旧 Broker 后重新安装并启动当前 runtime",
            {"expected_executable_name": executable.name, "actual_executable_name": str(metadata.get("name", "缺失")), "parent_executable_name": str(metadata.get("parent_name", "缺失"))},
        )
    actual_created_at = metadata.get("process_created_at")
    if not timestamps_match(actual_created_at, status.get("process_created_at")):
        return broker_failure(
            "LOCAL_JOB_BROKER_PROCESS_TIME_MISMATCH",
            "Broker 进程创建时间与状态文件不一致",
            "停止旧 Broker 后重新启动本地识别组件",
            {"expected_process_created_at": status.get("process_created_at"), "actual_process_created_at": actual_created_at},
        )
    return broker_ready()


def broker_readiness(current: Dict[str, object], status: Dict[str, object]) -> BrokerReadiness:
    quick = broker_quick_readiness(current, status)
    if not quick.ready:
        return quick
    return broker_process_readiness(current, status)


def broker_healthy(current: Dict[str, object], status: Dict[str, object]) -> bool:
    return broker_readiness(current, status).ready


def broker_readiness_snapshot() -> BrokerReadiness:
    current = broker_current()
    status, status_error = read_broker_status(appdata_docxtool_root() / "broker" / "status.json")
    return status_error or broker_readiness(current, status)


def readiness_technical_detail(readiness: BrokerReadiness) -> str:
    return "；".join(f"{key}={value}" for key, value in readiness.details.items())


def step_failed_for_readiness(readiness: BrokerReadiness) -> StepFailed:
    error_code = readiness.error_code or "LOCAL_JOB_BROKER_READY_TIMEOUT"
    return StepFailed(
        "启动本地任务 Broker",
        "docxtool-job-broker.exe",
        error_code,
        reason_cn=readiness.reason_cn or "本地任务代理在规定时间内没有进入就绪状态",
        action_cn=readiness.action_cn or "查看统一日志中的错误码并修复后重试",
        error_code=error_code,
        details=readiness.details,
    )


def stop_job_broker() -> None:
    current = broker_current()
    executable = Path(str(current.get("broker_executable_path", "")))
    metadata = read_json(JOB_BROKER_PROCESS)
    pid = metadata.get("pid")
    if not pid or not managed_broker_process(pid, executable, metadata.get("process_created_at"), current.get("broker_executable_path_hash")):
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
    status, status_error = read_broker_status(appdata_docxtool_root() / "broker" / "status.json")
    initial_readiness = status_error or broker_readiness(current, status)
    if initial_readiness.ready:
        JOB_BROKER_PROCESS.parent.mkdir(parents=True, exist_ok=True)
        JOB_BROKER_PROCESS.write_text(json.dumps({"pid": status.get("pid"), "executable": str(executable), "runtime_version": current.get("runtime_version"), "runtime_sha256": current.get("executable_sha256"), "started_at": status.get("started_at", ""), "process_created_at": status.get("process_created_at", ""), "broker_instance_id": status.get("broker_instance_id", "")}, ensure_ascii=False, indent=2), encoding="utf-8")
        log_event("INFO", "broker.reused", "本地任务代理已复用", {"result_cn": "成功", "technical_detail": f"PID {status.get('pid')}"})
        return status
    previous_instance_id = status.get("broker_instance_id")
    stale_pid = status.get("pid")
    switching_build = False
    if stale_pid:
        managed = managed_broker_process(stale_pid, executable, status.get("process_created_at"), current.get("broker_executable_path_hash"))
        if not managed and process_is_alive(stale_pid):
            raise StepFailed(
                "启动本地任务 Broker",
                "Broker 身份校验",
                "LOCAL_JOB_BROKER_EXECUTABLE_IDENTITY_MISMATCH",
                reason_cn="发现存活的同名进程，但无法证明它属于当前 runtime",
                action_cn="不要结束未知进程；先停止旧 Broker 后重新安装本地识别组件",
                error_code="LOCAL_JOB_BROKER_EXECUTABLE_IDENTITY_MISMATCH",
                details={"pid": stale_pid, "expected_executable_name": executable.name},
            )
        if managed:
            switching_build = initial_readiness.error_code in BROKER_SWITCH_ERROR_CODES
            if switching_build:
                log_event(
                    "INFO",
                    "broker.switch.start",
                    "检测到本地任务代理仍在使用上一构建，正在切换到当前版本",
                    {"stage_cn": "切换本地任务代理", "technical_detail": f"PID {stale_pid}"},
                )
            subprocess.run(["pwsh", "-NoProfile", "-Command", "Stop-Process", "-Id", str(int(stale_pid))], cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    log_event("INFO", "broker.start", "开始启动本地任务代理", {"stage_cn": "启动本地任务代理"})
    process = subprocess.Popen([str(executable), "run", "--log-path", str(WPS_LOG)], cwd=str(ROOT), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags, close_fds=True)
    JOB_BROKER_PROCESS.parent.mkdir(parents=True, exist_ok=True)
    JOB_BROKER_PROCESS.write_text(json.dumps({"pid": process.pid, "executable": str(executable), "runtime_version": current.get("runtime_version"), "runtime_sha256": current.get("executable_sha256"), "started_at": utc_now(), "process_created_at": ""}, ensure_ascii=False, indent=2), encoding="utf-8")
    deadline = time.monotonic() + BROKER_READY_TIMEOUT_SECONDS
    identity_readiness: Optional[BrokerReadiness] = None
    current_process_readiness: Optional[BrokerReadiness] = None
    observed_status_pid: object = None
    while time.monotonic() < deadline:
        exit_code = process.poll()
        if exit_code is not None:
            readiness = broker_failure(
                "LOCAL_JOB_BROKER_EXITED",
                "Broker 在写入就绪状态前已经退出",
                "查看统一日志中的 Broker 启动错误和退出码后重试",
                {"launcher_pid": process.pid, "exit_code": exit_code},
            )
            raise step_failed_for_readiness(readiness)
        status, status_error = read_broker_status(appdata_docxtool_root() / "broker" / "status.json")
        observed_status_pid = status.get("pid")
        if status_error:
            readiness = status_error
        elif previous_instance_id and status.get("broker_instance_id") == previous_instance_id:
            readiness = broker_failure(
                "LOCAL_JOB_BROKER_INSTANCE_PENDING",
                "正在等待当前 Broker 写入新的状态文件",
                "等待当前 Broker 完成启动",
                {"previous_instance_id": previous_instance_id, "actual_pid": status.get("pid")},
            )
        else:
            quick = broker_quick_readiness(current, status)
            if quick.ready:
                if identity_readiness is None:
                    identity_readiness = broker_process_readiness(current, status)
                readiness = identity_readiness
            else:
                readiness = quick
            current_process_readiness = readiness
        if readiness.ready:
            JOB_BROKER_PROCESS.write_text(json.dumps({"pid": status.get("pid"), "executable": str(executable), "runtime_version": current.get("runtime_version"), "runtime_sha256": current.get("executable_sha256"), "started_at": status.get("started_at", ""), "process_created_at": status.get("process_created_at", ""), "broker_instance_id": status.get("broker_instance_id", "")}, ensure_ascii=False, indent=2), encoding="utf-8")
            if switching_build:
                log_event("INFO", "broker.switch.completed", "本地任务代理已切换到当前构建", {"result_cn": "成功", "technical_detail": f"PID {status.get('pid')}"})
            else:
                log_event("INFO", "broker.ready", "本地任务代理已就绪", {"result_cn": "成功", "technical_detail": f"PID {status.get('pid')}"})
            return status
        if current_process_readiness is not None:
            raise step_failed_for_readiness(current_process_readiness)
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(0.1, remaining))
    raise step_failed_for_readiness(broker_failure(
        "LOCAL_JOB_BROKER_READY_TIMEOUT",
        "本地任务代理在规定时间内没有写入当前进程的就绪状态",
        "查看统一日志中的 Broker 启动错误和退出状态后重试",
        {"launcher_pid": process.pid, "observed_status_pid": observed_status_pid},
    ))


def fetch_resource(relative: str) -> Dict[str, object]:
    url = f"http://127.0.0.1:{WPSJS_PORT}/{relative.lstrip('/')}"
    try:
        request = urllib.request.Request(url, headers={"X-Docxtool-Probe": "1"})
        with urllib.request.urlopen(request, timeout=3) as response:
            content = response.read()
            return {
                "path": relative,
                "status": int(response.status),
                "content_type": response.headers.get("Content-Type", ""),
                "content_length": int(response.headers.get("Content-Length", "-1")),
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
                "content": content,
                "text": content.decode("utf-8", errors="replace"),
            }
    except ValueError as error:
        return {"path": relative, "status": 0, "error": str(error), "content": b"", "text": ""}
    except (OSError, urllib.error.URLError) as error:
        return {"path": relative, "status": 0, "error": str(error), "content": b"", "text": ""}


def probe_debug_server() -> Dict[str, object]:
    manifest = read_json(DEBUG_MANIFEST)
    required = ["index.html", "main.js", "ribbon.xml", "js/bootstrap-probe.js", "js/ribbon.js", "host-runtime.js", "pipeline-worker-probe.js", "pipeline-worker.js", "ui/build-info.js", "ui/local-runtime-config.js", "ui/default-format-profile.js", "ui/taskpane.html"]
    resources = {path: fetch_resource(path) for path in required}
    errors: List[str] = []
    build_root = ROOT / "apps" / "classified-offline" / "dist"
    for path, item in resources.items():
        if item.get("status") != 200:
            errors.append(f"RESOURCE_UNAVAILABLE:{path}")
    expected_bytes: Dict[str, bytes] = {}
    for path in ("index.html", "main.js", "host-runtime.js", "js/ribbon.js"):
        expected_path = build_root / path
        if not expected_path.is_file():
            errors.append(f"BUILD_ASSET_MISSING:{path}")
            continue
        content = expected_path.read_bytes()
        expected_bytes[path] = content
        served = resources[path]
        if served.get("status") != 200:
            continue
        expected_type = {
            "index.html": "text/html; charset=utf-8",
            "main.js": "application/javascript; charset=utf-8",
            "host-runtime.js": "application/javascript; charset=utf-8",
            "js/ribbon.js": "application/javascript; charset=utf-8",
        }[path]
        if served.get("content_type") != expected_type:
            errors.append("WPS_INDEX_RESPONSE_MISMATCH" if path == "index.html" else f"BUILD_ASSET_MISMATCH:{path}")
        actual = served.get("content")
        if actual != content:
            errors.append("WPS_INDEX_RESPONSE_MISMATCH" if path == "index.html" else f"BUILD_ASSET_MISMATCH:{path}")
        if served.get("content_length") != len(content) or served.get("bytes") != len(content) or served.get("sha256") != hashlib.sha256(content).hexdigest():
            errors.append("WPS_INDEX_RESPONSE_MISMATCH" if path == "index.html" else f"BUILD_ASSET_MISMATCH:{path}")
    index_expected = expected_bytes.get("index.html", b"")
    index_served = resources["index.html"].get("content", b"")
    if index_expected and b"/hot-update-inject.js" in index_served:
        errors.append("WPS_INDEX_RESPONSE_MISMATCH")
    main_text = str(resources["main.js"].get("text", "")); ribbon_text = str(resources["js/ribbon.js"].get("text", "")); host_text = str(resources["host-runtime.js"].get("text", "")); build_text = str(resources["ui/build-info.js"].get("text", ""))
    if not all(marker in main_text for marker in ("js/bootstrap-probe.js", "js/ribbon.js", "host-runtime.js")) or "type='module'" in main_text or "dist/host-runtime.js" in main_text: errors.append("MAIN_ENTRY_MISMATCH")
    if not all(marker in ribbon_text for marker in ("DocxtoolRunLocalCommand", "window.OnAction", "ribbon.action.received")) or "DocxtoolHostEnqueue" in ribbon_text: errors.append("RIBBON_ENTRY_MISMATCH")
    if not all(marker in host_text for marker in ("host.module.loaded", "DocxtoolRunLocalCommand", "pipeline.worker.probe.start")) or "import(" in host_text: errors.append("LOCAL_RUNTIME_BUNDLE_MISMATCH")
    expected_build = str(manifest.get("build_id", ""))
    if expected_build and expected_build not in build_text: errors.append("BUILD_ID_MISMATCH")
    critical = manifest.get("critical_assets", {}) if isinstance(manifest.get("critical_assets"), dict) else {}
    for path, expected_hash in critical.items():
        if resources.get(str(path), {}).get("sha256") != expected_hash: errors.append(f"ASSET_HASH_MISMATCH:{path}")
    report: Dict[str, object] = {"schema_version": 1, "expected_build_id": expected_build, "served_build_id": expected_build if not errors else "", "status": "PASS" if not errors else "FAIL", "errors": sorted(set(errors)), "build_root": "apps/classified-offline/dist", "resources": [{key: value for key, value in item.items() if key not in ("text", "content")} for item in resources.values()]}
    RESOURCE_PROBE.parent.mkdir(parents=True, exist_ok=True); RESOURCE_PROBE.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report


def log_index_verification(report: Dict[str, object]) -> None:
    build_index = ROOT / "apps" / "classified-offline" / "dist" / "index.html"
    index_expected = build_index.read_bytes() if build_index.is_file() else b""
    resources = report.get("resources", [])
    index_report = next((item for item in resources if isinstance(item, dict) and item.get("path") == "index.html"), {})
    if "WPS_INDEX_RESPONSE_MISMATCH" in report.get("errors", []):
        log_event(
            "ERROR",
            "wps.resource.index.verify.failed",
            "插件首页响应与当前构建不一致",
            {
                "stage_cn": "校验 WPS 主资源",
                "reason_cn": "资源服务返回内容被动态修改",
                "action_cn": "检查静态资源响应逻辑，禁止动态注入或重新编码 index.html",
                "stable_error_code": "WPS_INDEX_RESPONSE_MISMATCH",
                "expected_bytes": len(index_expected),
                "served_bytes": index_report.get("bytes", 0),
                "expected_sha256_prefix": hashlib.sha256(index_expected).hexdigest()[:12] if index_expected else "",
                "served_sha256_prefix": str(index_report.get("sha256", ""))[:12],
                "technical_detail": f"构建长度：{len(index_expected)}；响应长度：{index_report.get('bytes', 0)}；构建摘要：{hashlib.sha256(index_expected).hexdigest()[:12] if index_expected else '无'}；响应摘要：{str(index_report.get('sha256', ''))[:12]}",
            },
            component="debug_server",
        )
    elif index_expected:
        log_event(
            "INFO",
            "wps.resource.index.verify.completed",
            "插件首页响应与当前构建完全一致",
            {
                "result_cn": "成功",
                "file_size": len(index_expected),
                "file_sha256_prefix": hashlib.sha256(index_expected).hexdigest()[:12],
            },
            component="debug_server",
        )
def write_process_metadata(process: subprocess.Popen[bytes], manifest: Dict[str, object], command: List[str]) -> None:
    WPSJS_PROCESS.parent.mkdir(parents=True, exist_ok=True)
    WPSJS_PROCESS.write_text(json.dumps({"pid": process.pid, "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "cwd": str(DEBUG_PACKAGE), "expected_build_id": manifest.get("build_id", ""), "port": WPSJS_PORT, "command": command}, ensure_ascii=False, indent=2), encoding="utf-8")


def port_owner_info() -> Dict[str, object]:
    script = f"$c=Get-NetTCPConnection -LocalPort {WPSJS_PORT} -State Listen -ErrorAction SilentlyContinue|Select-Object -First 1;if($c){{$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$c.OwningProcess);$parent=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.ParentProcessId);[pscustomobject]@{{pid=$c.OwningProcess;name=$p.Name;command_line=$p.CommandLine;parent_process_id=$p.ParentProcessId;parent_name=$parent.Name;parent_process_created_at=$parent.CreationDate.ToUniversalTime().ToString('o')}}|ConvertTo-Json -Compress}}"
    try:
        output = subprocess.check_output(["pwsh", "-NoProfile", "-Command", script], cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", timeout=10).strip()
        value = json.loads(output) if output else {}
        return value if isinstance(value, dict) else {}
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}


def managed_debug_server_owner(metadata: Dict[str, object], owner: Dict[str, object]) -> bool:
    if Path(str(metadata.get("cwd", ""))).resolve() != DEBUG_PACKAGE.resolve() or not owner.get("pid"):
        return False
    command = metadata.get("command")
    if not isinstance(command, list) or str(ROOT / "scripts" / "wps_debug_server.py") not in command or str(DEBUG_PACKAGE) not in command:
        return False
    command_line = str(owner.get("command_line") or "")
    if str(DEBUG_PACKAGE) in command_line and "wps_debug_server.py" in command_line:
        return True
    return (
        owner.get("parent_process_id") == metadata.get("pid")
        and str(owner.get("name") or "").casefold() == "python.exe"
        and str(owner.get("parent_name") or "").casefold() == "python.exe"
        and timestamps_match(owner.get("parent_process_created_at"), metadata.get("started_at"))
    )


def managed_debug_server_stop_pid(metadata: Dict[str, object], owner: Dict[str, object]) -> str:
    return str(metadata.get("pid") if owner.get("parent_process_id") == metadata.get("pid") else owner.get("pid", ""))


def update_server_owner_metadata() -> None:
    value = read_json(WPSJS_PROCESS); value["server_process"] = port_owner_info()
    WPSJS_PROCESS.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def register_addin(*, force_restart: bool = False) -> None:
    if is_port_open(WPSJS_PORT):
        report = probe_debug_server()
        metadata = read_json(WPSJS_PROCESS)
        owner = port_owner_info()
        command_line = str(owner.get("command_line") or "")
        # The launcher process can exit after creating a child on Windows, so
        # the port owner PID is not required to equal the recorded Popen PID.
        # The package directory and command kind are the safety boundary.
        managed_owner = managed_debug_server_owner(metadata, owner)
        if not force_restart and report.get("status") == "PASS" and managed_owner:
            metadata["expected_build_id"] = read_json(DEBUG_MANIFEST).get("build_id", "")
            WPSJS_PROCESS.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
            log_index_verification(report)
            log_event("INFO", "debug_server.reused", "WPS 资源服务已验证并复用", {"result_cn": "成功"})
            return
        if managed_owner:
            pid = managed_debug_server_stop_pid(metadata, owner)
            if pid.isdigit():
                if force_restart:
                    log_event("INFO", "debug_server.restart", "当前构建已完成，重启 WPS 资源服务", {"stage_cn": "同步当前构建"})
                stopped = subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                if stopped.returncode != 0:
                    raise StepFailed(
                        "停止受管理 WPS 资源服务",
                        "taskkill",
                        "WPSJS_MANAGED_PROCESS_STOP_FAILED",
                        reason_cn="当前会话没有权限停止受管理的旧 WPS 资源服务",
                        action_cn="从启动旧服务的同一权限终端关闭它，再重新运行 main.py",
                        error_code="WPSJS_MANAGED_PROCESS_STOP_FAILED",
                    )
                for _ in range(20):
                    if not is_port_open(WPSJS_PORT):
                        break
                    time.sleep(0.25)
        if is_port_open(WPSJS_PORT):
            raise StepFailed(
                "停止受管理 WPS 资源服务" if managed_owner else "启动 WPS 调试服务",
                "wps_debug_server.py",
                "WPSJS_MANAGED_PROCESS_STOP_FAILED" if managed_owner else "WPSJS_PORT_OCCUPIED_BY_UNMANAGED_PROCESS",
                reason_cn="受管理的旧 WPS 资源服务在停止后仍占用端口" if managed_owner else "3889 端口被未知进程占用",
                action_cn="确认旧服务已退出后重试" if managed_owner else "不要结束未知进程；先确认端口归属后重试",
                error_code="WPSJS_MANAGED_PROCESS_STOP_FAILED" if managed_owner else "WPSJS_PORT_OCCUPIED_BY_UNMANAGED_PROCESS",
            )

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
            log_index_verification(report)
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
    broker_check = broker_readiness_snapshot()
    checks = [
        ("WPS资源服务", resource.get("status") == "PASS"),
        ("WPS注册配置", bool(registration.get("registration_matches_current_server"))),
        ("插件页面", plugin_page_loaded(names)),
        ("功能区脚本", "ribbon.script.loaded" in names),
        ("功能区回调", "ribbon.addin.load.success" in names),
        ("WPS宿主运行时", "application.install.success" in names),
        ("本地任务代理", broker_check.ready),
    ]
    print("WPS 装载诊断：")
    for label, passed in checks: print(f"- {label}：{'正常' if passed else '等待'}")
    if not broker_check.ready:
        print("- Broker 失败阶段：校验本地任务代理")
        print(f"- Broker 具体原因：{broker_check.reason_cn}")
        print(f"- Broker 错误码：{broker_check.error_code}")
        print(f"- Broker 建议处理：{broker_check.action_cn}")
        detail = readiness_technical_detail(broker_check)
        if detail:
            print(f"- Broker 诊断详情：{detail}")
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


def watch_wps_log(*, announce: bool = True) -> None:
    if announce:
        log_event("INFO", "logs.watch.started", "开始监视 WPS 统一日志", {"summary_lines": ["日志文件：wps-plugin.log", "等待 WPS 操作；按 Ctrl+C 停止监视"]})
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
            prepare(rebuild_runtime=False)
            verify()
            run_step("同步最终 WPS 调试包", "pwsh -NoProfile -File scripts/prepare-wps-debug-package.ps1", "最终 WPS 调试包已同步。", timeout=60)
            ensure_control_server()
            register_addin(force_restart=True)
            print_status(startup=True, watch_logs=not args.once)
            if not args.once:
                watch_wps_log(announce=False)
        elif args.action == "prepare":
            prepare(rebuild_runtime=True)
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
        error_code = error.error_code or useful_error(error.output)
        reason_cn = error.reason_cn or "当前启动步骤失败"
        action_cn = error.action_cn or "查看统一日志中的错误码并修复后重试"
        data: Dict[str, object] = {
            "stage_cn": error.title,
            "reason_cn": reason_cn,
            "action_cn": action_cn,
            "stable_error_code": error_code,
        }
        details = error.details or {}
        if details:
            data["technical_detail"] = "；".join(f"{key}={value}" for key, value in details.items())
        elif useful_error(error.output):
            data["technical_detail"] = useful_error(error.output)
        log_event("ERROR", "launcher.failed", "WPS 启动流程未完成", data, error)
        print(f"处理未完成。错误码：{error_code}；原因：{reason_cn}；建议：{action_cn}", flush=True)
        print("详细诊断已写入 wps-plugin.log。", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
