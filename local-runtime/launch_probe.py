"""Minimal native-launch probe used only to verify the WPS launch boundary."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


def probe_directory() -> Path:
    appdata = os.environ.get("APPDATA", "").strip()
    if not appdata:
        raise RuntimeError("APPDATA_UNAVAILABLE")
    return Path(appdata) / "Docxtool" / "launch-probe"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_atomic(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="process-started-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    try:
        write_atomic(
            probe_directory() / "process-started.json",
            {
                "schema_version": 1,
                "pid": os.getpid(),
                "started_at": utc_now(),
                "argv_count": 1 + len(arguments),
            },
        )
        time.sleep(0.05)
        return 0
    except Exception as error:  # pragma: no cover - exercised through the CLI boundary
        print(f"LAUNCH_PROBE_FAILED: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
