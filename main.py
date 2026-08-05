from __future__ import annotations

import argparse
import json
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional


ROOT = Path(__file__).resolve().parent
WPSJS_PORT = 3889
WPS_LOG = ROOT / "wps-plugin-debug.log"


class StepFailed(RuntimeError):
    def __init__(self, title: str, command: str, output: str) -> None:
        self.title = title
        self.command = command
        self.output = output
        super().__init__(title)


def run_command(command: str, *, cwd: Path = ROOT, timeout: int = 180) -> str:
    result = subprocess.run(
        command,
        cwd=str(cwd),
        shell=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )
    output = result.stdout or ""
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
    print(f"- 注册项目：{'已加载开发注册配置' if values.get('plugin_registration') else '未确认'}")
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


def is_port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def register_addin() -> None:
    if is_port_open(WPSJS_PORT):
        print("注册项目已加载。", flush=True)
        return

    npx = shutil.which("npx.cmd") or shutil.which("npx")
    if not npx:
        raise StepFailed("注册 WPS 插件项目", "npx --no-install wpsjs debug -s", "没有找到 npx，请先安装 Node.js。")

    print("正在注册 WPS 插件项目……", flush=True)
    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    process = subprocess.Popen(
        [npx, "--no-install", "wpsjs", "debug", "-s"],
        cwd=str(ROOT / "apps" / "classified-offline"),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )
    for _ in range(30):
        if is_port_open(WPSJS_PORT):
            print("注册项目已加载。", flush=True)
            return
        if process.poll() is not None:
            raise StepFailed("注册 WPS 插件项目", "npx --no-install wpsjs debug -s", "WPS 插件服务启动后立即退出。")
        time.sleep(0.5)
    raise StepFailed("注册 WPS 插件项目", "npx --no-install wpsjs debug -s", f"等待端口 {WPSJS_PORT} 就绪超时。")


def verify() -> None:
    run_step("执行 WPS 本地直连功能检测", "npm run verify:local-direct", "WPS 功能检测已完成。", timeout=240)


def watch_wps_log() -> None:
    print(f"WPS 交互日志：{WPS_LOG}", flush=True)
    print("正在等待 WPS 操作日志；按 Ctrl+C 停止监视。", flush=True)
    position = WPS_LOG.stat().st_size if WPS_LOG.exists() else 0
    try:
        while True:
            if WPS_LOG.exists():
                size = WPS_LOG.stat().st_size
                if size < position:
                    position = 0
                with WPS_LOG.open("r", encoding="utf-8", errors="replace") as handle:
                    handle.seek(position)
                    for line in handle:
                        try:
                            item = json.loads(line)
                            level = str(item.get("level", "INFO"))
                            component = str(item.get("component", "WPS"))
                            message = str(item.get("message", item.get("event", "收到日志")))
                            error = item.get("error") or {}
                            suffix = f"；错误：{error.get('message')}" if error.get("message") else ""
                            print(f"[{level}] {component}：{message}{suffix}", flush=True)
                        except (ValueError, TypeError):
                            print(f"[WPS] {line.strip()}", flush=True)
                    position = handle.tell()
            time.sleep(0.5)
    except KeyboardInterrupt:
        print("已停止日志监视；WPS 加载项服务继续在后台运行。", flush=True)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Docxtool WPS 本地直连启动入口")
    parser.add_argument(
        "action",
        nargs="?",
        default="start",
        choices=("start", "prepare", "status", "stop", "reset", "verify"),
        help="start=完整启动；prepare=准备构建；status=查看状态；verify=功能检测",
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
