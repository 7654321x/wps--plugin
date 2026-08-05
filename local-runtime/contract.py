"""Local runtime request/host snapshot contract for docxtool-recognize."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

HOST_TEXT_CONTRACT_VERSION = "host-text-v1"
OFFSET_ENCODING = "utf16_code_unit"
REQUEST_SCHEMA_VERSION = 1
CONTRACT_VERSION = 1


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise ValueError(code)


def build_host_snapshot(
    host_type: str,
    paragraphs,
    *,
    document_identity=None,
    document_revision=None,
):
    """Return the redacted host-snapshot-v1 payload."""
    _require(isinstance(host_type, str) and host_type, "INVALID_HOST_SNAPSHOT")
    _require(isinstance(paragraphs, list), "INVALID_HOST_SNAPSHOT")

    normalized = []
    story_positions = {}
    for ordinal, item in enumerate(paragraphs):
        _require(isinstance(item, dict), "INVALID_HOST_SNAPSHOT")
        host_index = item.get("host_paragraph_index", ordinal)
        raw_text = item.get("raw_text")
        story_type = str(item.get("story_type", "main") or "main")
        story_id = str(item.get("story_id", story_type) or story_type)
        is_in_table = item.get("is_in_table", False)
        if not isinstance(host_index, int) or host_index < 0 or not isinstance(raw_text, str):
            raise ValueError("INVALID_HOST_SNAPSHOT")
        if not isinstance(is_in_table, bool):
            raise ValueError("INVALID_HOST_SNAPSHOT")
        story_index = item.get("story_paragraph_index")
        if story_index is None:
            story_index = story_positions.get(story_id, 0)
        if not isinstance(story_index, int) or story_index < 0:
            raise ValueError("INVALID_HOST_SNAPSHOT")
        section_index = item.get("section_index")
        if section_index is not None and (not isinstance(section_index, int) or section_index < 0):
            raise ValueError("INVALID_HOST_SNAPSHOT")
        host_paragraph_id = str(item.get("host_paragraph_id", f"{story_id}:{host_index:06d}") or "")
        _require(bool(host_paragraph_id), "INVALID_HOST_SNAPSHOT")
        normalized.append({
            "host_paragraph_id": host_paragraph_id,
            "host_paragraph_index": host_index,
            "story_id": story_id,
            "story_type": story_type,
            "story_paragraph_index": story_index,
            "section_index": section_index,
            "is_in_table": is_in_table,
            "raw_text": raw_text,
        })
        story_positions[story_id] = story_index + 1

    identity = str(document_identity) if document_identity is not None else None
    revision = str(document_revision) if document_revision is not None else None
    digest_input = [
        host_type,
        identity,
        revision,
        [
            (
                item["host_paragraph_id"],
                item["host_paragraph_index"],
                item["story_id"],
                item["story_type"],
                hashlib.sha256(item["raw_text"].encode("utf-8")).hexdigest(),
            )
            for item in normalized
        ],
    ]
    snapshot_id = "snap_" + hashlib.sha256(
        json.dumps(digest_input, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).hexdigest()[:32]
    return {
        "schema_version": "host-snapshot-v1",
        "integration_contract_version": "integration-contract-v1",
        "snapshot_id": snapshot_id,
        "document_identity": identity,
        "document_revision": revision,
        "host": {"kind": host_type, "version": None, "platform": None},
        "host_type": host_type,
        "text_contract_version": HOST_TEXT_CONTRACT_VERSION,
        "offset_encoding": OFFSET_ENCODING,
        "paragraphs": normalized,
    }


def validate_request(value: dict) -> dict:
    _require(isinstance(value, dict), "INVALID_REQUEST")
    required_keys = {"schema_version", "request_id", "source_path", "result_path", "error_path", "host_snapshot"}
    _require(set(value) == required_keys, "INVALID_REQUEST")
    _require(value.get("schema_version") == REQUEST_SCHEMA_VERSION, "INVALID_REQUEST")
    for key in ("request_id", "source_path", "result_path", "error_path"):
        _require(isinstance(value.get(key), str) and value[key], "INVALID_REQUEST")
    host_snapshot = value.get("host_snapshot")
    _require(isinstance(host_snapshot, dict), "INVALID_HOST_SNAPSHOT")
    required_host_keys = {"host_type", "document_identity", "document_revision", "text_contract_version", "paragraphs"}
    _require(set(host_snapshot) == required_host_keys, "INVALID_HOST_SNAPSHOT")
    _require(host_snapshot.get("text_contract_version", HOST_TEXT_CONTRACT_VERSION) == HOST_TEXT_CONTRACT_VERSION, "INVALID_HOST_SNAPSHOT")
    _require(isinstance(host_snapshot.get("host_type"), str) and host_snapshot["host_type"], "INVALID_HOST_SNAPSHOT")
    _require(isinstance(host_snapshot.get("paragraphs"), list), "INVALID_HOST_SNAPSHOT")
    return value


def build_runtime_host_snapshot(request: dict) -> dict:
    host_snapshot = request["host_snapshot"]
    paragraphs = []
    for item in host_snapshot["paragraphs"]:
        _require(isinstance(item, dict), "INVALID_HOST_SNAPSHOT")
        required_paragraph_keys = {"host_paragraph_index", "raw_text", "story_type", "is_in_table"}
        _require(set(item) == required_paragraph_keys, "INVALID_HOST_SNAPSHOT")
        paragraphs.append({
            "host_paragraph_index": item["host_paragraph_index"],
            "raw_text": item["raw_text"],
            "story_type": item.get("story_type", "main") or "main",
            "is_in_table": item.get("is_in_table", False),
        })
    return build_host_snapshot(
        host_snapshot["host_type"],
        paragraphs,
        document_identity=host_snapshot.get("document_identity"),
        document_revision=host_snapshot.get("document_revision"),
    )


def atomic_write_json(path: str | Path, payload: dict) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix(target.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(target)
