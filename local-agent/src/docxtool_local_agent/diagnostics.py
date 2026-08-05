"""Safe JSONL diagnostics written only by the loopback local agent."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import re
import threading
from typing import Any, Dict, List, Union


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
        if not event_name or len(event_name) > 160 or not component or len(component) > 80:
            raise ValueError("DIAGNOSTIC_EVENT_INVALID")
        item = _sanitize(raw)
        item["timestamp"] = str(item.get("timestamp") or datetime.now(timezone.utc).isoformat())
        item["level"] = level
        item["component"] = component
        item["event"] = event_name
        normalized.append(item)
    return normalized


class DiagnosticLogWriter:
    def __init__(
        self,
        log_file: Union[str, Path],
        *,
        max_bytes: int = 5 * 1024 * 1024,
        backup_count: int = 5,
    ) -> None:
        self.path = Path(log_file).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._logger = logging.getLogger("docxtool.diagnostics.{}.{}".format(self.path, id(self)))
        self._logger.setLevel(logging.DEBUG)
        self._logger.propagate = False
        handler = RotatingFileHandler(
            self.path,
            maxBytes=max_bytes,
            backupCount=backup_count,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter("%(message)s"))
        self._logger.addHandler(handler)
        self.handler = handler

    def append(self, events: List[Dict[str, Any]]) -> None:
        with self._lock:
            for event in events:
                self._logger.info(
                    json.dumps(_sanitize(event), ensure_ascii=False, separators=(",", ":"))
                )
            for handler in self._logger.handlers:
                handler.flush()

    def path_info(self) -> Dict[str, Any]:
        return {
            "file_name": self.path.name,
            "exists": self.path.exists(),
            "size_bytes": self.path.stat().st_size if self.path.exists() else 0,
        }
