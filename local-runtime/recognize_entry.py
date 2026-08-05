"""Standalone local recognition runtime for the WPS local-direct path."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from contract import (  # noqa: E402
    CONTRACT_VERSION,
    REQUEST_SCHEMA_VERSION,
    atomic_write_json,
    build_runtime_host_snapshot,
    validate_request,
)
from docxtool.sdk import RecognitionInputError, RecognitionSdkError, bind_recognition_plan, recognize_docx  # noqa: E402


def package_version() -> str:
    try:
        return version("docxtool")
    except PackageNotFoundError:
        return "unknown"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
      for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_error_code(error: Exception) -> str:
    if isinstance(error, (RecognitionInputError, RecognitionSdkError)) and getattr(error, "code", ""):
        return str(error.code)
    if isinstance(error, FileNotFoundError):
        return "LOCAL_RECOGNITION_SOURCE_NOT_FOUND"
    if isinstance(error, PermissionError):
        return "LOCAL_RECOGNITION_SOURCE_UNAVAILABLE"
    if isinstance(error, ValueError):
        message = str(error).strip()
        if message in {"INVALID_REQUEST", "INVALID_HOST_SNAPSHOT"}:
            return message
    message = str(error).strip()
    return message if message and message.isupper() and len(message) <= 80 else "LOCAL_RECOGNITION_FAILED"


def recognize_request(request_path: Path) -> dict:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    validate_request(request)
    source = Path(request["source_path"]).expanduser()
    if source.suffix.lower() != ".docx" or not source.is_file():
        raise ValueError("INVALID_DOCX_INPUT")
    before = sha256_file(source)
    plan = recognize_docx(
        source,
        recognition_mode="legacy",
        include_text=True,
        include_raw_text=True,
    )
    host_snapshot = build_runtime_host_snapshot(request)
    binding = bind_recognition_plan(plan, host_snapshot)
    after = sha256_file(source)
    if before != after:
        raise RuntimeError("INPUT_FILE_CHANGED")
    payload = plan.to_dict()
    payload["binding"] = binding.to_dict()
    return {
        "schema_version": REQUEST_SCHEMA_VERSION,
        "request_id": request["request_id"],
        "recognition_plan": payload,
        "runtime": {
            "contract_version": CONTRACT_VERSION,
            "package_version": package_version(),
        },
    }


def write_error(path: Path, request_id: str, error: Exception) -> None:
    atomic_write_json(path, {
        "schema_version": REQUEST_SCHEMA_VERSION,
        "request_id": request_id,
        "error_code": stable_error_code(error),
    })


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="docxtool-recognize", description="Docxtool local recognition runtime")
    parser.add_argument("--request", required=True)
    parser.add_argument("--result", required=True)
    parser.add_argument("--error", required=True)
    args = parser.parse_args(argv)

    request_path = Path(args.request)
    result_path = Path(args.result)
    error_path = Path(args.error)
    request_id = "unknown"
    try:
        request = json.loads(request_path.read_text(encoding="utf-8"))
        request_id = str(request.get("request_id", request_id))
        validate_request(request)
        payload = recognize_request(request_path)
        atomic_write_json(result_path, payload)
        return 0
    except Exception as error:  # noqa: BLE001 - stable runtime error mapping
        try:
            write_error(error_path, request_id, error if isinstance(error, Exception) else Exception(str(error)))
        except Exception:
            pass
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
