from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional


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


ROOT = Path(__file__).resolve().parent
WPSJS_PORT = 3889
WPS_LOG = ROOT / "wps-plugin-debug.log"
# All plugin diagnostics are deliberately kept in the repository root.  The
# former AppData path is no longer used for user-facing logs.
WPS_EARLY_LOG = WPS_LOG
DEBUG_PACKAGE = ROOT / ".runtime" / "wps-debug-package"
DEBUG_MANIFEST = DEBUG_PACKAGE / "debug-package.json"
WPSJS_LOG = ROOT / ".runtime" / "logs" / "wpsjs-debug.log"
WPSJS_PROCESS = ROOT / ".runtime" / "wpsjs-debug-process.json"
RESOURCE_PROBE = ROOT / ".runtime" / "resource-probe.json"


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
    print(f"正在{title}……", flush=True)
    try:
        output = run_command(command, cwd=cwd, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        print(f"{title}超时。", flush=True)
        raise StepFailed(title, command, str(error)) from error
    except StepFailed as error:
        print(f"{title}失败：{useful_error(error.output)}", flush=True)
        raise
    print(success, flush=True)
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
    print(f"- 旧 local-agent：{'未使用' if values.get('local_agent') == 'NOT_USED' else '异常运行中'}")
    print(f"- 旧 command-service：{'未使用' if values.get('command_service') == 'NOT_USED' else '异常运行中'}")
    print(f"- 旧 9528 端口：{'已关闭' if values.get('port_9528') == 'CLOSED' else '仍在监听'}")
    print("- 识别方式：本地进程")
    print("- 排版命令：插件内部生成")


def prepare() -> None:
    run_step("构建本地识别组件", "npm run build:local-runtime", "本地识别组件构建完成。", timeout=240)
    run_step("安装本地识别组件", "npm run install:local-runtime", "本地识别组件已安装。")
    run_step("构建 WPS 插件", "npm run build:classified", "WPS 插件构建完成。")
    run_step("检查 WPS 插件结构", "npm run verify:addin -- classified-offline", "WPS 插件结构检查已完成。")
    run_step("生成 WPS 调试包", "pwsh -NoProfile -File scripts/prepare-wps-debug-package.ps1", "WPS 调试包已生成。")


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
            print("WPS 调试服务已验证并复用。", flush=True)
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
    print("正在后台启动 WPS 插件资源……", flush=True)
    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    command = [sys.executable, "-u", str(ROOT / "scripts" / "wps_debug_server.py"), "--root", str(DEBUG_PACKAGE), "--port", str(WPSJS_PORT), "--log", str(WPS_LOG)]
    WPSJS_LOG.parent.mkdir(parents=True, exist_ok=True)
    log_handle = WPSJS_LOG.open("a", encoding="utf-8", buffering=1)
    process = subprocess.Popen(
        command,
        cwd=str(DEBUG_PACKAGE),
        stdin=subprocess.DEVNULL,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        creationflags=creationflags,
    )
    log_handle.close()
    write_process_metadata(process, read_json(DEBUG_MANIFEST), command)
    for _ in range(30):
        if is_port_open(WPSJS_PORT):
            report = probe_debug_server()
            if report.get("status") != "PASS":
                raise StepFailed("验证 WPS 调试资源", "HTTP resource probe", ",".join(str(item) for item in report.get("errors", [])))
            update_server_owner_metadata()
            print("DEBUG_SERVER_READY", flush=True)
            print("REGISTRATION_READY", flush=True)
            return
        if process.poll() is not None:
            raise StepFailed("注册 WPS 插件项目", "wps_debug_server.py", "WPS 插件服务启动后立即退出。")
        time.sleep(0.5)
    raise StepFailed("启动 WPS 调试服务", "wps_debug_server.py", f"等待端口 {WPSJS_PORT} 就绪超时。")


def verify() -> None:
    run_step("执行 WPS 本地直连功能检测", "npm run verify:local-direct", "WPS 功能检测已完成。", timeout=240)


def diagnostic_events() -> List[Dict[str, object]]:
    events: List[Dict[str, object]] = []
    current_build = str(read_json(DEBUG_MANIFEST).get("build_id", ""))
    for path in dict.fromkeys((WPS_EARLY_LOG, WPS_LOG)):
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                value = json.loads(line)
                if isinstance(value, dict) and (not current_build or value.get("build_id") == current_build): events.append(value)
            except ValueError:
                continue
    events.sort(key=lambda item: str(item.get("timestamp", "")))
    return events


def plugin_page_loaded(event_names: List[str]) -> bool:
    return any(name in event_names for name in ("bootstrap.probe.loaded", "ribbon.script.loaded", "host.module.loaded"))


def diagnose() -> None:
    resource = probe_debug_server() if is_port_open(WPSJS_PORT) else {"status": "FAIL", "errors": ["DEBUG_SERVER_NOT_RUNNING"]}
    registration_raw = run_command("pwsh -NoProfile -File scripts/inspect-wps-registration.ps1", timeout=30)
    registration = json.loads(registration_raw)
    events = diagnostic_events(); names = [str(item.get("event", "")) for item in events]
    checks = [
        ("debug server", resource.get("status") == "PASS"),
        ("registration", bool(registration.get("registration_matches_current_server"))),
        ("bootstrap page", plugin_page_loaded(names)),
        ("ribbon script", "ribbon.script.loaded" in names),
        ("ribbon onLoad", "ribbon.addin.load.success" in names),
        ("local runtime", "application.install.success" in names),
    ]
    print("WPS 装载诊断：")
    for label, passed in checks: print(f"- {label}: {'PASS' if passed else 'WAITING'}")
    last_action = next((item for item in reversed(events) if item.get("event") == "ribbon.action.received"), None)
    last_error = next((item for item in reversed(events) if item.get("level") in ("ERROR", "FATAL")), None)
    print(f"- last ribbon action: {last_action.get('timestamp') if last_action else '-'}")
    print(f"- last error: {last_error.get('message') if last_error else '-'}")
    if not plugin_page_loaded(names):
        print("WPS 尚未加载当前插件页面。请保存文档并完全关闭全部 WPS 进程后重新打开。")


def wps_is_running() -> bool:
    try:
        output = subprocess.check_output(["pwsh", "-NoProfile", "-Command", "@(Get-Process wps -ErrorAction SilentlyContinue).Count"], cwd=str(ROOT), text=True, encoding="utf-8", errors="replace", timeout=10)
        return int(output.strip() or "0") > 0
    except (OSError, subprocess.SubprocessError, ValueError):
        return False


def watch_wps_log() -> None:
    print(f"WPS 早期日志：{WPS_EARLY_LOG}", flush=True)
    print(f"WPS 交互日志：{WPS_LOG}", flush=True)
    print(f"插件资源日志：{WPSJS_LOG}", flush=True)
    print("正在等待 WPS 操作日志；只显示根目录中文交互日志；按 Ctrl+C 停止监视。", flush=True)
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
                        try:
                            item = json.loads(line)
                            level = str(item.get("level", "INFO"))
                            component = str(item.get("component", "WPS"))
                            message = str(item.get("message", item.get("event", "收到日志")))
                            error = item.get("error") or {}
                            error_message = str(error.get("message", ""))
                            stable_code = str((item.get("data") or {}).get("stable_error_code", ""))
                            if "path cannot contains" in error_message.lower() or stable_code == "WPS_FILESYSTEM_PATH_REJECTED":
                                error_message = "WPS 文件接口拒绝了当前路径参数"
                            suffix = f"；错误：{error_message}" if error_message else ""
                            fingerprint = "|".join((level, component, str(item.get("event", "")), message, error_message, stable_code))
                            if fingerprint == last_fingerprint:
                                suppressed_repeats += 1
                                continue
                            if suppressed_repeats:
                                print(f"[提示] 上一条相同日志重复 {suppressed_repeats} 次，已自动省略。", flush=True)
                                suppressed_repeats = 0
                            last_fingerprint = fingerprint
                            print(f"[{level}] {component}：{message}{suffix}", flush=True)
                        except (ValueError, TypeError):
                            print(f"[WPS] {line.strip()}", flush=True)
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
        choices=("start", "prepare", "status", "diagnose", "logs", "stop", "reset", "verify"),
        help="start=完整启动；prepare=准备构建；status=查看状态；diagnose=装载诊断；logs=交互日志；verify=功能检测",
    )
    parser.add_argument("--once", action="store_true", help="启动完成后立即返回，不持续监视 WPS 日志")
    args = parser.parse_args(argv)

    print("Docxtool WPS 本地直连版", flush=True)
    print("说明：本入口不启动 9528，不启动 local-agent，不启动 command-service。", flush=True)

    try:
        if args.action == "start":
            prepare()
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
            run_step("停止本入口管理的开发资源", "pwsh -NoProfile -File scripts/local-direct.ps1 stop", "已停止。本操作不会关闭 WPS。")
        elif args.action == "reset":
            run_step("重置本地识别组件指针", "pwsh -NoProfile -File scripts/local-direct.ps1 reset", "本地识别组件指针已重置。")
        return 0
    except StepFailed:
        print("处理未完成。请把上面的中文错误发给我继续排查。", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
