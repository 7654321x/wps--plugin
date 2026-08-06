"""Validated diagnostic events written as one human-readable Chinese log."""

from __future__ import annotations

import json
from pathlib import Path
import re
import sys
from typing import Any, Dict, List, Union

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from wps_logging import UnifiedLogWriter  # noqa: E402


MAX_BATCH_EVENTS = 100
MAX_EVENT_BYTES = 64 * 1024
MAX_STRING = 4096
MAX_STACK = 12 * 1024
MAX_DEPTH = 6
MAX_ARRAY = 100

SENSITIVE_KEY = re.compile(
    r"token|authorization|cookie|password|secret|"
    r"raw_text|document_text|body|content|source_path|"
    r"full_?name|file_?path",
    re.IGNORECASE,
)
SAFE_METADATA_KEYS = {
    "content_length",
    "endpoint_path",
    "request_size_bytes",
    "response_size_bytes",
}
SENSITIVE_VALUE = re.compile(
    r"\b(authorization|cookie|password|secret|session[_-]?token|access[_-]?token)"
    r"\s*[:=]\s*[^\s,;]+",
    re.IGNORECASE,
)
BEARER_VALUE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/\-]+", re.IGNORECASE)
WINDOWS_PATH = re.compile(r"(?<![A-Za-z])[A-Za-z]:[\\/](?:[^\s\r\n:'\"]+[\\/])*[^\s\r\n:'\"]*")

LEVELS = {"TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"}


def _clip(value: str, limit: int = MAX_STRING) -> str:
    if len(value) <= limit:
        return value
    return value[:limit] + "…[truncated:{}]".format(len(value) - limit)


def _redact_string(value: str) -> str:
    value = SENSITIVE_VALUE.sub(lambda match: "{}=[redacted]".format(match.group(1)), value)
    value = BEARER_VALUE.sub("Bearer [redacted]", value)
    return WINDOWS_PATH.sub("[local-path]", value)


def _sensitive_key(key: str) -> bool:
    normalized = key.lower()
    if normalized in SAFE_METADATA_KEYS:
        return False
    return normalized == "path" or bool(SENSITIVE_KEY.search(key))


def _sanitize(value: Any, *, depth: int = 0, key: str = "") -> Any:
    if _sensitive_key(key):
        return "[redacted]"
    if depth > MAX_DEPTH:
        return "[max-depth]"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _clip(_redact_string(value), MAX_STACK if key == "stack" else MAX_STRING)
    if isinstance(value, (list, tuple)):
        return [_sanitize(item, depth=depth + 1) for item in value[:MAX_ARRAY]]
    if isinstance(value, dict):
        return {
            str(item_key): _sanitize(item_value, depth=depth + 1, key=str(item_key))
            for item_key, item_value in value.items()
        }
    return _clip(_redact_string(str(value)))


def validate_batch(payload: Any) -> List[Dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ValueError("DIAGNOSTIC_BATCH_REQUIRED")
    if payload.get("schema_version") != 1:
        raise ValueError("DIAGNOSTIC_SCHEMA_UNSUPPORTED")
    source = payload.get("source")
    if source not in {"main", "ribbon", "host", "taskpane"}:
        raise ValueError("DIAGNOSTIC_SOURCE_INVALID")
    events = payload.get("events")
    if not isinstance(events, list) or not events or len(events) > MAX_BATCH_EVENTS:
        raise ValueError("DIAGNOSTIC_EVENT_COUNT_INVALID")

    normalized = []
    for raw in events:
        if not isinstance(raw, dict):
            raise ValueError("DIAGNOSTIC_EVENT_INVALID")
        encoded = json.dumps(raw, ensure_ascii=False).encode("utf-8")
        if len(encoded) > MAX_EVENT_BYTES:
            raise ValueError("DIAGNOSTIC_EVENT_TOO_LARGE")
        level = str(raw.get("level", "INFO")).upper()
        if level not in LEVELS:
            raise ValueError("DIAGNOSTIC_LEVEL_INVALID")
        event_name = str(raw.get("event", "")).strip()
        component = str(raw.get("component", source)).strip()
        message = raw.get("message")
        timestamp = raw.get("timestamp")
        if not event_name or len(event_name) > 160 or not component or len(component) > 80 or not isinstance(message, str) or not message.strip() or not isinstance(timestamp, str) or not timestamp.strip():
            raise ValueError("DIAGNOSTIC_EVENT_INVALID")
        item = _sanitize(raw)
        item["level"] = level
        item["component"] = component
        item["event"] = event_name
        normalized.append(item)
    return normalized


class DiagnosticLogWriter(UnifiedLogWriter):
    """Compatibility name for the single human-readable log writer."""

    def __init__(self, log_file: Union[str, Path], *, max_bytes: int = 5 * 1024 * 1024, backup_count: int = 0) -> None:
        del backup_count
        super().__init__(log_file, max_bytes=max_bytes, keep_bytes=2 * 1024 * 1024)
