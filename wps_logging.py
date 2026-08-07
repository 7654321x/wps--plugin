"""Single human-readable runtime log boundary for the WPS plugin."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import re
import threading
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple, Union


LEVEL_LABELS = {
    "TRACE": "调试",
    "DEBUG": "调试",
    "INFO": "信息",
    "WARN": "警告",
    "ERROR": "错误",
    "FATAL": "致命",
}
LEVEL_ORDER = {"TRACE": 0, "DEBUG": 1, "INFO": 2, "WARN": 3, "ERROR": 4, "FATAL": 5}
COMPONENT_LABELS = {
    "main": "启动器",
    "launcher": "启动器",
    "debug_server": "WPS资源服务",
    "ribbon": "功能区",
    "bootstrap": "启动探针",
    "host": "WPS宿主",
    "taskpane": "任务窗格",
    "worker": "工作线程",
    "pipeline-worker-client": "工作线程",
    "broker": "本地任务代理",
    "recognizer": "文档识别器",
    "control_server": "控制服务",
    "command_service": "命令服务",
    "local-agent": "本地识别服务",
}
COMMAND_LABELS = {
    "health_check": "本机检测",
    "preview_document": "预览排版",
    "format_document": "一键排版",
    "clear_preview": "清除预览",
    "toggle_taskpane": "打开或关闭面板",
    "open_taskpane": "打开面板",
    "close_taskpane": "关闭面板",
    "recognize_document": "识别文档",
    "probe_shell_execute_one_argument": "本地启动边界探针",
}
STATUS_LABELS = {
    "RUNNING": "执行中",
    "PASS": "成功",
    "WARN": "警告",
    "FAIL": "失败",
    "CANCELLED": "已取消",
    "NOT_RUN": "未运行",
    "UNSUPPORTED": "不支持",
    "IDLE": "就绪",
}
ERROR_CATALOG: Dict[str, Dict[str, str]] = {
    "LOCAL_RUNTIME_CONFIGURATION_REQUIRED": {
        "stage_cn": "读取本地运行时配置",
        "reason_cn": "没有找到有效的本地运行时配置",
        "action_cn": "重新执行 python main.py start 后重启 WPS",
    },
    "PRODUCTION_COMPOSITION_NOT_READY": {
        "stage_cn": "等待本地运行时配置",
        "reason_cn": "插件页面资源或运行时配置尚未就绪",
        "action_cn": "等待插件加载完成；若持续出现，请完全关闭 WPS 后重新打开",
    },
    "WPS_FILESYSTEM_PATH_REJECTED": {
        "stage_cn": "读取 WPS 文件",
        "reason_cn": "WPS 文件接口拒绝了当前路径参数",
        "action_cn": "检查运行时清单路径是否经过统一的 WPS 路径适配",
    },
    "LOCAL_JOB_BROKER_NOT_RUNNING": {
        "stage_cn": "连接本地任务代理",
        "reason_cn": "本地任务代理未运行或状态已过期",
        "action_cn": "执行 python main.py start，再运行“本机检测”",
    },
    "LOCAL_JOB_BROKER_NOT_FOUND": {
        "stage_cn": "检查本地任务代理",
        "reason_cn": "没有找到受信任的本地任务代理程序",
        "action_cn": "重新构建并安装本地识别组件",
    },
    "LOCAL_JOB_BROKER_SHA256_MISMATCH": {
        "stage_cn": "校验本地任务代理文件",
        "reason_cn": "Broker 文件哈希与当前 runtime 清单不一致",
        "action_cn": "重新构建并安装本地识别组件",
    },
    "LOCAL_JOB_BROKER_RUNTIME_MISMATCH": {
        "stage_cn": "读取本地运行时清单",
        "reason_cn": "运行时清单版本或合同不一致",
        "action_cn": "重新安装本地识别组件后重试",
    },
    "LOCAL_JOB_BROKER_RECOGNIZER_NOT_ALLOWED": {
        "stage_cn": "校验本地识别程序路径",
        "reason_cn": "运行时清单中的识别程序路径不在受信 runtime 内",
        "action_cn": "重新安装本地识别组件后重试",
    },
    "LOCAL_JOB_BROKER_RUNTIME_SHA256_MISMATCH": {
        "stage_cn": "校验本地识别程序文件",
        "reason_cn": "识别程序文件哈希与运行时清单不一致",
        "action_cn": "重新构建并安装本地识别组件",
    },
    "LOCAL_JOB_BROKER_IDENTITY_MISMATCH": {
        "stage_cn": "校验本地任务代理身份",
        "reason_cn": "运行时清单中的 Broker 身份字段不一致",
        "action_cn": "重新构建并安装当前 Broker",
    },
    "LOCAL_JOB_BROKER_HASH_MISMATCH": {
        "stage_cn": "校验本地任务代理文件",
        "reason_cn": "Broker 文件哈希与运行时清单不一致",
        "action_cn": "重新构建并安装当前 Broker",
    },
    "LOCAL_JOB_BROKER_STATUS_WRITE_FAILED": {
        "stage_cn": "写入本地任务代理状态",
        "reason_cn": "Broker 无法写入就绪状态文件",
        "action_cn": "检查本地 runtime 状态目录权限后重试",
    },
    "LOCAL_JOB_BROKER_READY_TIMEOUT": {
        "stage_cn": "启动本地任务代理",
        "reason_cn": "本地任务代理在规定时间内没有进入就绪状态",
        "action_cn": "执行 python main.py start 并检查本地 runtime 安装状态",
    },
    "LOCAL_JOB_BROKER_STATUS_MISSING": {
        "stage_cn": "校验本地任务代理状态",
        "reason_cn": "Broker 状态文件尚未生成",
        "action_cn": "检查 Broker 是否已启动，并查看统一日志中的 Broker 启动事件",
    },
    "LOCAL_JOB_BROKER_STATUS_INVALID": {
        "stage_cn": "校验本地任务代理状态",
        "reason_cn": "Broker 状态文件无法通过严格格式校验",
        "action_cn": "停止旧 Broker 后重新安装本地识别组件",
    },
    "LOCAL_JOB_BROKER_STATE_INVALID": {
        "stage_cn": "校验本地任务代理状态",
        "reason_cn": "Broker 状态不是可服务的 READY 或 RUNNING",
        "action_cn": "查看 Broker 启动日志并修复状态对应的错误",
    },
    "LOCAL_JOB_BROKER_PID_MISMATCH": {
        "stage_cn": "校验本地任务代理进程",
        "reason_cn": "Broker 状态 PID 与受信启动记录不一致",
        "action_cn": "停止旧 Broker 后重新启动本地识别组件",
    },
    "LOCAL_JOB_BROKER_HEARTBEAT_INVALID": {
        "stage_cn": "校验本地任务代理心跳",
        "reason_cn": "Broker 心跳时间格式无效",
        "action_cn": "检查本机时间和 Broker 统一日志后重启",
    },
    "LOCAL_JOB_BROKER_HEARTBEAT_STALE": {
        "stage_cn": "校验本地任务代理心跳",
        "reason_cn": "Broker 状态文件存在，但心跳已超过允许时间",
        "action_cn": "检查 Broker 是否卡在初始化阶段后重启",
    },
    "LOCAL_JOB_BROKER_VERSION_MISMATCH": {
        "stage_cn": "校验本地任务代理版本",
        "reason_cn": "Broker 版本与当前安装版本不一致",
        "action_cn": "停止旧 Broker 后重新启动本地识别组件",
    },
    "LOCAL_JOB_BROKER_EXECUTABLE_HASH_MISMATCH": {
        "stage_cn": "校验本地任务代理文件",
        "reason_cn": "运行中的 Broker 文件哈希与当前 runtime 清单不一致",
        "action_cn": "重新构建并安装本地识别组件后重试",
    },
    "LOCAL_JOB_BROKER_RUNTIME_VERSION_MISMATCH": {
        "stage_cn": "校验本地识别运行时版本",
        "reason_cn": "Broker 使用的运行时版本与当前安装版本不一致",
        "action_cn": "停止旧 Broker 后重新启动本地识别组件",
    },
    "LOCAL_JOB_BROKER_RUNTIME_HASH_MISMATCH": {
        "stage_cn": "校验本地识别运行时文件",
        "reason_cn": "Broker 使用的识别程序哈希与当前安装版本不一致",
        "action_cn": "重新安装本地识别组件后重试",
    },
    "LOCAL_JOB_BROKER_QUEUE_CONTRACT_MISMATCH": {
        "stage_cn": "校验本地任务队列合同",
        "reason_cn": "Broker 文件队列合同版本与当前 runtime 不一致",
        "action_cn": "重新安装本地识别组件，不要回退旧服务链",
    },
    "LOCAL_JOB_BROKER_CONTRACT_MISMATCH": {
        "stage_cn": "校验本地任务代理合同",
        "reason_cn": "Broker 合同版本与当前 runtime 不一致",
        "action_cn": "重新安装本地识别组件后重试",
    },
    "LOCAL_JOB_BROKER_PROCESS_NOT_RUNNING": {
        "stage_cn": "校验本地任务代理进程",
        "reason_cn": "Broker 状态已通过文件校验，但对应进程已经退出",
        "action_cn": "查看 Broker 统一日志中的退出原因后重新启动",
    },
    "LOCAL_JOB_BROKER_PROCESS_METADATA_UNAVAILABLE": {
        "stage_cn": "读取本地任务代理进程身份",
        "reason_cn": "无法读取 Broker 进程身份信息",
        "action_cn": "检查 PowerShell/CIM 进程查询权限后重试，不要跳过校验",
    },
    "LOCAL_JOB_BROKER_EXECUTABLE_IDENTITY_MISMATCH": {
        "stage_cn": "校验本地任务代理可执行文件",
        "reason_cn": "Broker PID 对应的可执行文件不是当前受信 runtime",
        "action_cn": "停止旧 Broker 后重新安装并启动当前 runtime",
    },
    "LOCAL_JOB_BROKER_COMMAND_LINE_MISMATCH": {
        "stage_cn": "校验本地任务代理命令行",
        "reason_cn": "Broker PID 对应的命令行不是受信任的启动命令",
        "action_cn": "停止该进程后重新启动当前本地任务代理",
    },
    "LOCAL_JOB_BROKER_PROCESS_TIME_MISMATCH": {
        "stage_cn": "校验本地任务代理进程时间",
        "reason_cn": "Broker 进程创建时间与状态文件不一致",
        "action_cn": "停止旧 Broker 后重新启动本地识别组件",
    },
    "LOCAL_JOB_BROKER_EXITED": {
        "stage_cn": "启动本地任务代理",
        "reason_cn": "Broker 在写入就绪状态前已经退出",
        "action_cn": "查看统一日志中的 Broker 启动错误和退出码后重试",
    },
    "PIPELINE_WORKER_NOT_READY": {
        "stage_cn": "启动工作线程",
        "reason_cn": "WPS 工作线程尚未准备完成",
        "action_cn": "等待初始化完成后重试；若持续出现，请完全关闭 WPS 后重新打开",
    },
    "PIPELINE_WORKER_CONSTRUCTION_FAILED": {
        "stage_cn": "创建工作线程",
        "reason_cn": "WPS 无法创建后台工作线程",
        "action_cn": "完全关闭 WPS 后重新打开，并重新运行“本机检测”",
    },
    "TASKPANE_CREATE_FAILED": {
        "stage_cn": "创建任务窗格",
        "reason_cn": "WPS 没有返回可用的任务窗格对象",
        "action_cn": "关闭并重新打开 WPS 后重试",
    },
    "TASKPANE_SHOW_FAILED": {
        "stage_cn": "显示任务窗格",
        "reason_cn": "WPS 拒绝显示任务窗格",
        "action_cn": "关闭并重新打开 WPS 后重试",
    },
    "TASKPANE_BRIDGE_NOT_READY": {
        "stage_cn": "连接任务窗格",
        "reason_cn": "WPS 任务窗格接口尚未就绪",
        "action_cn": "等待宿主加载完成后重试",
    },
    "TASKPANE_REQUEST_PERSIST_FAILED": {
        "stage_cn": "写入任务窗格请求",
        "reason_cn": "任务窗格请求没有写入 WPS PluginStorage",
        "action_cn": "重新打开任务窗格后重试",
    },
    "HOST_COMMAND_TIMEOUT": {
        "stage_cn": "等待 WPS 宿主处理请求",
        "reason_cn": "WPS 主上下文在规定时间内没有消费请求",
        "action_cn": "完全关闭 WPS 后重新打开并重试",
    },
    "RIBBON_CALLBACK_NOT_FOUND": {
        "stage_cn": "分发功能区命令",
        "reason_cn": "没有找到当前按钮对应的命令映射",
        "action_cn": "重新加载当前版本插件；若持续出现，请检查功能区清单",
    },
    "LOCAL_APPLICATION_RUNTIME_NOT_READY": {
        "stage_cn": "调用 WPS 宿主运行时",
        "reason_cn": "WPS 宿主运行时尚未安装完成",
        "action_cn": "等待插件加载完成后重试；若持续出现，请完全关闭 WPS 后重新打开",
    },
    "LOCAL_APPLICATION_COMMAND_FAILED": {
        "stage_cn": "执行 WPS 宿主命令",
        "reason_cn": "WPS 宿主命令返回失败",
        "action_cn": "查看同一请求的后续错误码并按处理建议操作",
    },
    "WPS_INDEX_RESPONSE_MISMATCH": {
        "stage_cn": "校验 WPS 主资源",
        "reason_cn": "资源服务返回的 index.html 内容与当前构建不一致",
        "action_cn": "删除首页响应阶段的动态注入或文本替换后重新启动",
    },
    "WPS_BUILD_ASSET_CHANGED": {
        "stage_cn": "校验资源构建",
        "reason_cn": "服务中的关键资源在启动后发生变化",
        "action_cn": "停止当前资源服务并重新生成唯一调试包",
    },
    "WEB_WORKER_UNSUPPORTED": {
        "stage_cn": "检测工作线程能力",
        "reason_cn": "当前 WPS 不支持 classic Worker",
        "action_cn": "保持线程预览关闭并使用支持 Worker 的 WPS 版本",
    },
    "LOCAL_RECOGNITION_RUNTIME_NOT_FOUND": {
        "stage_cn": "检查本地识别程序",
        "reason_cn": "没有找到受信任的本地识别程序",
        "action_cn": "重新执行 python main.py start 安装本地识别组件",
    },
    "LOCAL_RECOGNITION_TIMEOUT": {
        "stage_cn": "等待文档识别器",
        "reason_cn": "本地文档识别程序运行超时",
        "action_cn": "检查本地 runtime 状态后重试",
    },
    "UNKNOWN_LOCAL_COMMAND": {
        "stage_cn": "校验 WPS 宿主命令",
        "reason_cn": "收到未登记的本地命令",
        "action_cn": "重新加载当前版本插件，不要使用旧页面发起请求",
    },
    "DIAGNOSTIC_EVENT_FAILED": {
        "stage_cn": "记录运行时诊断",
        "reason_cn": "收到的诊断事件没有提供可识别的稳定错误码",
        "action_cn": "查看同一请求的前后事件并重新执行操作",
    },
}
PLACEHOLDER_MESSAGES = {
    "Host command failed": "WPS 宿主命令执行失败",
    "Unknown error": "发生未分类运行时错误",
    "Request failed": "请求执行失败",
    "Not ready": "运行时尚未就绪",
    "UNKNOWN_FETCH_FAILURE": "本地请求失败",
}
SENSITIVE_VALUE = re.compile(r"\b(authorization|cookie|password|secret|session[_-]?token|access[_-]?token)\s*[:=]\s*[^\s,;]+", re.IGNORECASE)
BEARER_VALUE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/\-]+", re.IGNORECASE)
WINDOWS_PATH = re.compile(r"(?<![A-Za-z])[A-Za-z]:[\\/](?:[^\s\r\n:'\"]+[\\/])*[^\s\r\n:'\"]*")
URL_VALUE = re.compile(r"https?://[^\s|]+", re.IGNORECASE)
ERROR_CODE = re.compile(r"\b[A-Z][A-Z0-9_:-]{3,}\b")
LINE_PREFIX = re.compile(r"^(?P<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[(?P<level>[^]]+)\] \[(?P<component>[^]]+)\] (?P<message>.*?)(?:｜(?P<fields>.*))?$")


def _clip(value: str, limit: int = 4096) -> str:
    return value if len(value) <= limit else value[:limit] + "…"


def redact_text(value: str, limit: int = 4096) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ").replace("｜", "/")
    text = SENSITIVE_VALUE.sub(lambda match: f"{match.group(1)}=[已脱敏]", text)
    text = BEARER_VALUE.sub("Bearer [已脱敏]", text)
    text = WINDOWS_PATH.sub("[本机路径]", text)
    text = URL_VALUE.sub("[本地地址]", text)
    return _clip(text, limit)


def _first_string(values: Iterable[Any]) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _nested(raw: Dict[str, Any], key: str) -> Any:
    data = raw.get("data")
    if isinstance(data, dict) and key in data:
        return data[key]
    return raw.get(key)


def _timestamp(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("统一日志事件缺少时间戳")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("统一日志事件时间戳格式无效") from error
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone()
    return parsed.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def _display_component(value: str) -> str:
    return COMPONENT_LABELS.get(value, redact_text(value, 80) or "运行时")


def _display_message(raw: Any, code: str) -> str:
    message = redact_text(str(raw or ""), 240).strip()
    for placeholder, translated in PLACEHOLDER_MESSAGES.items():
        if message.casefold() == placeholder.casefold():
            message = translated
            break
    if not message or message.startswith("{"):
        message = "运行时事件"
    if not any("\u4e00" <= char <= "\u9fff" for char in message) and code in ERROR_CATALOG:
        message = ERROR_CATALOG[code].get("reason_cn", "运行时发生错误")
    return message


def _extract_error_code(raw: Dict[str, Any], level: str) -> str:
    value = _first_string((_nested(raw, "error_code"), _nested(raw, "stable_error_code"), raw.get("error_code")))
    if value:
        return redact_text(value, 120)
    technical_value = _first_string((_nested(raw, "technical_detail"), raw.get("technical_detail")))
    technical_match = ERROR_CODE.search(technical_value)
    if technical_match:
        return technical_match.group(0)
    error = raw.get("error")
    error_message = error.get("message") if isinstance(error, dict) else error
    match = ERROR_CODE.search(str(error_message or ""))
    if match:
        return match.group(0)
    return "DIAGNOSTIC_EVENT_FAILED" if level in {"ERROR", "FATAL"} else ""


def _status(raw: Dict[str, Any], event_code: str) -> str:
    value = _first_string((_nested(raw, "status"), raw.get("status"))).upper()
    if value in STATUS_LABELS:
        return STATUS_LABELS[value]
    if event_code.endswith((".success", ".completed", ".complete", ".ready")):
        return "成功"
    if event_code.endswith((".failed", ".failure", ".fatal")):
        return "失败"
    if event_code.endswith(".waiting"):
        return "等待"
    return ""


@dataclass(frozen=True)
class UnifiedLogEvent:
    timestamp: str
    level: str
    component: str
    event_code: str
    message_cn: str
    result_cn: str = ""
    stage_cn: str = ""
    reason_cn: str = ""
    action_cn: str = ""
    error_code: str = ""
    command_name: str = ""
    request_id: str = ""
    command_id: str = ""
    build_id: str = ""
    duration_ms: Optional[Union[int, float]] = None
    technical_detail: str = ""

    @property
    def fingerprint(self) -> Tuple[str, str, str, str]:
        return self.component, self.event_code, self.error_code, self.request_id


def normalize_event(raw: Dict[str, Any]) -> UnifiedLogEvent:
    data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
    event_code = _first_string((raw.get("event_code"), raw.get("event")))
    if not event_code:
        raise ValueError("统一日志事件缺少事件码")
    level_value = raw.get("level")
    if not isinstance(level_value, str) or not level_value.strip():
        raise ValueError("统一日志事件缺少级别")
    level = level_value.upper()
    if level not in LEVEL_LABELS:
        raise ValueError("统一日志事件级别无效")
    component_value = _first_string((raw.get("component"),))
    if not component_value:
        raise ValueError("统一日志事件缺少组件")
    if not isinstance(raw.get("message"), str) or not raw["message"].strip():
        raise ValueError("统一日志事件缺少消息")
    code = _extract_error_code(raw, level)
    catalog = ERROR_CATALOG.get(code, {})
    command_name = _first_string((raw.get("command_name"), data.get("command_name")))
    request_id = _first_string((raw.get("request_id"), data.get("request_id"), data.get("correlation_id")))
    command_id = _first_string((raw.get("command_id"), data.get("command_id")))
    build_id = _first_string((raw.get("build_id"), data.get("build_id")))
    duration = raw.get("duration_ms", data.get("duration_ms"))
    if not isinstance(duration, (int, float)) or isinstance(duration, bool):
        duration = None
    error = raw.get("error")
    error_message = error.get("message") if isinstance(error, dict) else error
    technical = _first_string((raw.get("technical_detail"), data.get("technical_detail"), error_message))
    if technical == code or technical in PLACEHOLDER_MESSAGES:
        technical = ""
    stage = _first_string((raw.get("stage_cn"), data.get("stage_cn"), catalog.get("stage_cn")))
    reason = _first_string((raw.get("reason_cn"), data.get("reason_cn"), catalog.get("reason_cn")))
    action = _first_string((raw.get("action_cn"), data.get("action_cn"), catalog.get("action_cn")))
    if event_code == "application.install.waiting" and not reason:
        stage = stage or "安装 WPS 宿主"
        reason = "WPS Application、构建信息或运行时配置尚未注入"
        action = "等待插件加载完成；若持续出现，请完全关闭 WPS 后重新打开"
    return UnifiedLogEvent(
        timestamp=_timestamp(raw.get("timestamp")),
        level=level,
        component=_display_component(component_value),
        event_code=redact_text(event_code, 160),
        message_cn=_display_message(raw.get("message"), code),
        result_cn=_status(raw, event_code),
        stage_cn=redact_text(stage, 160),
        reason_cn=redact_text(reason, 240),
        action_cn=redact_text(action, 240),
        error_code=code,
        command_name=COMMAND_LABELS.get(command_name, redact_text(command_name, 100)),
        request_id=redact_text(request_id, 100),
        command_id=redact_text(command_id, 100),
        build_id=redact_text(build_id, 120),
        duration_ms=duration,
        technical_detail=redact_text(technical, 240),
    )


def format_event(raw: Dict[str, Any]) -> str:
    event = normalize_event(raw)
    message = event.message_cn
    if event.command_name and event.command_name not in message and event.error_code:
        message = f"“{event.command_name}”{message}"
    fields: List[str] = []
    if event.error_code:
        for label, value in (("阶段", event.stage_cn), ("原因", event.reason_cn), ("处理建议", event.action_cn), ("错误码", event.error_code), ("请求", event.request_id), ("事件码", event.event_code)):
            if value and len(fields) < 6:
                fields.append(f"{label}：{value}")
    else:
        data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
        extra_fields = (
            ("文件", data.get("resource_path")),
            ("大小", f"{data.get('file_size')}字节" if isinstance(data.get("file_size"), (int, float)) else ""),
            ("摘要", data.get("file_sha256_prefix")),
            ("来源", data.get("source_address")),
            ("端口", data.get("port")),
        )
        values = (("命令", event.command_name), ("结果", event.result_cn), ("耗时", f"{event.duration_ms:g}毫秒" if event.duration_ms is not None else ""), ("请求", event.request_id), *extra_fields, ("构建", event.build_id), ("事件码", event.event_code))
        for label, value in values:
            if value and len(fields) < 6:
                fields.append(f"{label}：{redact_text(str(value), 160)}")
    if event.technical_detail and len(fields) < 7:
        fields.append(f"技术详情：{event.technical_detail}")
    line = f"{event.timestamp} [{LEVEL_LABELS[event.level]}] [{event.component}] {message}"
    if fields:
        line += "｜" + "｜".join(fields)
    data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
    summary_lines = data.get("summary_lines")
    if summary_lines is None:
        return line
    if not isinstance(summary_lines, list) or not all(isinstance(item, str) and item.strip() for item in summary_lines):
        raise TypeError("统一日志多行摘要必须是非空字符串数组")
    rendered = [redact_text(item.strip(), 320) for item in summary_lines]
    return line + "\n" + "\n".join(f"  - {item}" for item in rendered)


def parse_log_line(line: str) -> Optional[Dict[str, str]]:
    match = LINE_PREFIX.match(line.strip())
    if not match:
        return None
    value: Dict[str, str] = {
        "timestamp": match.group("timestamp"),
        "level": match.group("level"),
        "component": match.group("component"),
        "message": match.group("message"),
    }
    for field in (match.group("fields") or "").split("｜"):
        if "：" not in field:
            continue
        key, item = field.split("：", 1)
        key = key.strip()
        item = item.strip()
        if key == "事件码":
            value["event"] = item
        elif key == "错误码":
            value["stable_error_code"] = item
        elif key == "请求":
            value["request_id"] = item
        elif key == "命令":
            value["command_name"] = item
        elif key == "构建":
            value["build_id"] = item
    return value


def read_log_events(path: Path) -> List[Dict[str, str]]:
    if not path.exists():
        return []
    values = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        value = parse_log_line(line)
        if value:
            values.append(value)
    return values


class UnifiedLogWriter:
    def __init__(self, log_file: Union[str, Path], *, max_bytes: int = 5 * 1024 * 1024, keep_bytes: int = 2 * 1024 * 1024, minimum_level: str = "INFO") -> None:
        self.path = Path(log_file).resolve()
        self.max_bytes = max_bytes
        self.keep_bytes = min(keep_bytes, max_bytes)
        self.minimum_level = minimum_level.upper()
        self._lock = threading.Lock()
        self._last_fingerprint: Optional[Tuple[str, str, str, str]] = None
        self._suppressed = 0

    def append(self, events: Iterable[Dict[str, Any]]) -> List[str]:
        with self._lock:
            lines: List[str] = []
            for raw in events:
                if not isinstance(raw, dict):
                    raise TypeError("统一日志事件必须是对象")
                normalized = normalize_event(raw)
                if LEVEL_ORDER[normalized.level] < LEVEL_ORDER.get(self.minimum_level, LEVEL_ORDER["INFO"]):
                    continue
                if normalized.fingerprint == self._last_fingerprint:
                    self._suppressed += 1
                    continue
                self._last_fingerprint = normalized.fingerprint
                lines.append(format_event(raw))
            if lines:
                self._append_lines(lines)
            return lines

    def session_start(self, build_id: str = "", plugin_version: str = "") -> None:
        self._last_fingerprint = None
        self._suppressed = 0
        self.append([{
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": "INFO",
            "component": "main",
            "event": "session.start",
            "message": "新的 WPS 日志会话已开始",
            "build_id": build_id,
            "data": {"plugin_version": plugin_version},
        }])

    def _append_lines(self, lines: List[str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = ("\n".join(lines) + "\n").encode("utf-8")
        existing = self.path.read_bytes() if self.path.exists() else b""
        combined = existing + payload
        if len(combined) <= self.max_bytes:
            with self.path.open("ab") as handle:
                handle.write(payload)
            return
        prefix = "历史日志因文件过大已裁剪，仅保留最近记录。\n".encode("utf-8")
        target = min(self.keep_bytes, self.max_bytes)
        budget = max(0, target - len(prefix))
        chunks: List[bytes] = []
        size = 0
        for chunk in reversed(combined.splitlines(keepends=True)):
            if not chunks and len(prefix) + len(chunk) > self.max_bytes:
                continue
            if chunks and size + len(chunk) > budget:
                break
            chunks.append(chunk)
            size += len(chunk)
        retained = b"".join(reversed(chunks))
        self.path.write_bytes(prefix + retained)

    def path_info(self) -> Dict[str, Any]:
        return {"file_name": self.path.name, "exists": self.path.exists(), "size_bytes": self.path.stat().st_size if self.path.exists() else 0}
