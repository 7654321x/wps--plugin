"""Build the formal wheel HostSnapshot contract from local WPS text."""

import hashlib
import json


HOST_TEXT_CONTRACT_VERSION = "host-text-v1"
OFFSET_ENCODING = "utf16_code_unit"


def build_host_snapshot(
    host_type,
    paragraphs,
    *,
    document_identity=None,
    document_revision=None,
):
    """Return a complete host-snapshot-v1 payload without retaining extra text."""
    normalized = []
    story_positions = {}
    for ordinal, item in enumerate(paragraphs):
        if not isinstance(item, dict):
            raise ValueError("INVALID_HOST_SNAPSHOT")
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
        host_paragraph_id = str(
            item.get("host_paragraph_id", "{0}:{1:06d}".format(story_id, host_index)) or ""
        )
        if not host_paragraph_id:
            raise ValueError("INVALID_HOST_SNAPSHOT")
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
