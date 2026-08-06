"""Small, dependency-free contracts for the local control plane.

The control server deliberately validates the envelope here and leaves the
recognition and formatting payloads to their separately versioned adapters.
No WPS object, executable path, command line or code expression is accepted
as part of the control contract.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Dict, Mapping


CONTROL_CONTRACT_VERSION = 1
SERVER_VERSION = "1.4.0"
JOB_MODES = frozenset(("preview", "format", "recognize_only"))
JOB_STATUSES = frozenset(("queued", "recognizing", "planning", "completed", "failed", "cancelled"))
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")

REQUEST_KEYS = frozenset(
    (
        "schema_version",
        "request_id",
        "mode",
        "document_token",
        "document_revision",
        "snapshot_sha256",
        "snapshot",
        "profile_id",
        "profile_version",
        "client_capabilities",
    )
)

# These names are rejected recursively.  The request must be data, never an
# instruction to import or execute something chosen by a caller.
FORBIDDEN_EXECUTION_KEYS = frozenset(
    (
        "command",
        "commands",
        "code",
        "eval",
        "executable",
        "executable_path",
        "function",
        "import",
        "module",
        "powershell",
        "python",
        "script",
        "shell",
        "wscript",
    )
)
FORBIDDEN_RESULT_KEYS = frozenset(
    (
        "code",
        "eval",
        "executable",
        "executable_path",
        "function",
        "import",
        "javascript",
        "module",
        "powershell",
        "python",
        "script",
        "shell",
        "wscript",
    )
)


class ContractError(ValueError):
    """A client-safe contract error with a stable code."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def json_size(value: Any) -> int:
    return len(canonical_json(value).encode("utf-8"))


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _scan_forbidden(value: Any) -> None:
    if isinstance(value, Mapping):
        for key, nested in value.items():
            if isinstance(key, str) and key.casefold() in FORBIDDEN_EXECUTION_KEYS:
                raise ContractError("CONTROL_SERVER_EXECUTION_FIELD_REJECTED")
            _scan_forbidden(nested)
    elif isinstance(value, list):
        for item in value:
            _scan_forbidden(item)


def _scan_result_forbidden(value: Any) -> None:
    if isinstance(value, Mapping):
        for key, nested in value.items():
            if isinstance(key, str) and key.casefold() in FORBIDDEN_RESULT_KEYS:
                raise ContractError("CONTROL_SERVER_RESULT_EXECUTION_FIELD_REJECTED")
            _scan_result_forbidden(nested)
    elif isinstance(value, list):
        for item in value:
            _scan_result_forbidden(item)


def _require_string(payload: Mapping[str, Any], key: str, maximum: int = 512) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ContractError("CONTROL_SERVER_REQUEST_INVALID")
    return value


def validate_job_request(payload: Any, max_snapshot_bytes: int = 8 * 1024 * 1024) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise ContractError("CONTROL_SERVER_REQUEST_INVALID")
    _scan_forbidden(payload)
    if set(payload) - REQUEST_KEYS:
        raise ContractError("CONTROL_SERVER_REQUEST_FIELD_REJECTED")
    if payload.get("schema_version") != CONTROL_CONTRACT_VERSION:
        raise ContractError("CONTROL_SERVER_VERSION_MISMATCH")
    request_id = _require_string(payload, "request_id", 128)
    if not REQUEST_ID_RE.fullmatch(request_id):
        raise ContractError("CONTROL_SERVER_REQUEST_ID_INVALID")
    mode = payload.get("mode")
    if mode not in JOB_MODES:
        raise ContractError("CONTROL_SERVER_MODE_INVALID")
    _require_string(payload, "document_token", 256)
    _require_string(payload, "document_revision", 256)
    snapshot_hash = _require_string(payload, "snapshot_sha256", 64).casefold()
    if not SHA256_RE.fullmatch(snapshot_hash):
        raise ContractError("CONTROL_SERVER_SNAPSHOT_HASH_INVALID")
    snapshot = payload.get("snapshot")
    if not isinstance(snapshot, dict) or json_size(snapshot) > max_snapshot_bytes:
        raise ContractError("CONTROL_SERVER_SNAPSHOT_INVALID")
    profile_id = payload.get("profile_id", "default")
    profile_version = payload.get("profile_version", "1.0")
    if not isinstance(profile_id, str) or not profile_id or len(profile_id) > 128:
        raise ContractError("CONTROL_SERVER_PROFILE_INVALID")
    if not isinstance(profile_version, str) or not profile_version or len(profile_version) > 64:
        raise ContractError("CONTROL_SERVER_PROFILE_INVALID")
    capabilities = payload.get("client_capabilities", {})
    if not isinstance(capabilities, dict) or json_size(capabilities) > 128 * 1024:
        raise ContractError("CONTROL_SERVER_CAPABILITIES_INVALID")
    # Return a copy so the coordinator owns an immutable-enough snapshot of
    # the submitted contract and callers cannot mutate the record in place.
    return {
        "schema_version": CONTROL_CONTRACT_VERSION,
        "request_id": request_id,
        "mode": mode,
        "document_token": payload["document_token"],
        "document_revision": payload["document_revision"],
        "snapshot_sha256": snapshot_hash,
        "snapshot": snapshot,
        "profile_id": profile_id,
        "profile_version": profile_version,
        "client_capabilities": capabilities,
    }


def validate_result(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError("CONTROL_SERVER_RESULT_INVALID")
    _scan_result_forbidden(value)
    if not isinstance(value.get("recognition_result"), dict):
        raise ContractError("RECOGNITION_RESULT_INVALID")
    if not isinstance(value.get("formatting_plan"), dict):
        raise ContractError("FORMATTING_PLAN_INVALID")
    warnings = value.get("warnings", [])
    if not isinstance(warnings, list) or not all(isinstance(item, str) and len(item) <= 512 for item in warnings):
        raise ContractError("CONTROL_SERVER_RESULT_INVALID")
    return value
