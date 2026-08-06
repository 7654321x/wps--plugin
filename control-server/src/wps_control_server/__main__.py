"""Command-line entry point for the WPS Control Server."""

from __future__ import annotations

import argparse
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict

from .server import create_server, default_manifest_path


def _read_manifest(path: Path) -> Dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _health(manifest: Dict[str, Any]) -> Dict[str, Any]:
    base = str(manifest.get("base_url", ""))
    token = str(manifest.get("session_token", ""))
    if not base or not token:
        return {}
    request = urllib.request.Request(base + "/v1/health", headers={"Authorization": "Bearer " + token, "Host": "127.0.0.1"})
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            value = json.loads(response.read().decode("utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, urllib.error.URLError):
        return {}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="DocxTool WPS Control Server")
    parser.add_argument("action", choices=("start", "status"), nargs="?", default="start")
    parser.add_argument("--manifest", type=Path, default=default_manifest_path())
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args(argv)
    if args.action == "status":
        manifest = _read_manifest(args.manifest)
        health = _health(manifest)
        print(json.dumps({"manifest": manifest, "health": health}, ensure_ascii=False, indent=2))
        return 0 if health.get("status") == "ready" else 1
    server = create_server(args.manifest, args.port)
    try:
        server.start()
        print(json.dumps({"status": "ready", **server.manifest}, ensure_ascii=False), flush=True)
        server.wait()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
