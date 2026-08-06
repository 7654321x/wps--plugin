from __future__ import annotations

import hashlib
import json
from http import HTTPStatus
from pathlib import Path
import sys
import threading
import time
import urllib.error
import urllib.request

import pytest

import main

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.wps_debug_server import WpsDebugHandler, WpsDebugServer, asset_summary  # noqa: E402
from wps_logging import UnifiedLogWriter  # noqa: E402


@pytest.fixture()
def resource_server(tmp_path: Path):
    root = tmp_path / "dist"
    root.mkdir()
    index = "\ufeff<!doctype html>\r\n<body>中文 <&>\r\n<script src='./main.js'></script>\r\n</body>\r\n".encode("utf-8")
    (root / "index.html").write_bytes(index)
    (root / "main.js").write_bytes(b"console.log('main');\r\n")
    (root / "host-runtime.js").write_bytes(b"console.log('host');\r\n")
    (root / "js").mkdir()
    (root / "js" / "ribbon.js").write_bytes(b"console.log('ribbon');\r\n")
    log_path = tmp_path / "wps-plugin.log"
    server = WpsDebugServer(("127.0.0.1", 0), WpsDebugHandler)
    server.root = root  # type: ignore[attr-defined]
    server.build_id = "test-build"  # type: ignore[attr-defined]
    server.asset_metadata = asset_summary(root)  # type: ignore[attr-defined]
    server.log_writer = UnifiedLogWriter(log_path)  # type: ignore[attr-defined]
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    try:
        yield server, root, log_path
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def url(server: WpsDebugServer, path: str) -> str:
    return f"http://127.0.0.1:{server.server_address[1]}{path}"


def test_index_returns_original_bytes_and_headers(resource_server) -> None:
    server, root, _ = resource_server
    expected = (root / "index.html").read_bytes()
    with urllib.request.urlopen(url(server, "/index.html"), timeout=2) as response:
        actual = response.read()
        assert response.status == HTTPStatus.OK
        assert response.headers["Content-Type"] == "text/html; charset=utf-8"
        assert int(response.headers["Content-Length"]) == len(expected)
        assert actual == expected
    assert hashlib.sha256(actual).hexdigest() == hashlib.sha256(expected).hexdigest()
    assert b"/hot-update-inject.js" not in actual


def test_missing_javascript_is_a_plain_404(resource_server) -> None:
    server, root, _ = resource_server
    with pytest.raises(urllib.error.HTTPError) as raised:
        urllib.request.urlopen(url(server, "/missing.js"), timeout=2)
    response = raised.value
    body = response.read()
    assert response.code == HTTPStatus.NOT_FOUND
    assert not response.headers["Content-Type"].startswith("text/html")
    assert body != (root / "index.html").read_bytes()


def test_index_events_use_one_chinese_log_without_html(resource_server) -> None:
    server, _, log_path = resource_server
    with urllib.request.urlopen(url(server, "/index.html"), timeout=2):
        pass
    for _ in range(20):
        lines = log_path.read_text(encoding="utf-8").splitlines() if log_path.exists() else []
        if any("插件主页面已原样返回" in line for line in lines):
            break
        time.sleep(0.01)
    assert any("WPS 已请求插件主页面" in line for line in lines)
    assert any("插件主页面已原样返回" in line for line in lines)
    assert all("<body>" not in line for line in lines)
    assert all("/hot-update-inject.js" not in line for line in lines)


def test_probe_has_hard_index_byte_gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repository = tmp_path / "repo"
    build_root = repository / "apps" / "classified-offline" / "dist"
    build_root.mkdir(parents=True)
    assets = {
        "index.html": b"<!doctype html><script src='./main.js'></script>",
        "main.js": b"js/bootstrap-probe.js js/ribbon.js host-runtime.js",
        "host-runtime.js": b"host.module.loaded DocxtoolRunLocalCommand pipeline.worker.probe.start",
        "js/ribbon.js": b"DocxtoolRunLocalCommand window.OnAction ribbon.action.received",
    }
    (build_root / "js").mkdir()
    for relative, content in assets.items():
        path = build_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    required = [
        "ribbon.xml",
        "js/bootstrap-probe.js",
        "pipeline-worker-probe.js",
        "pipeline-worker.js",
        "ui/local-runtime-config.js",
        "ui/default-format-profile.js",
        "ui/taskpane.html",
    ]
    for relative in required:
        path = build_root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"asset")
    (build_root / "ui" / "build-info.js").write_text('window.DocxtoolBuildInfo={"build_id":"test-build"};', encoding="utf-8")
    debug_manifest = repository / ".runtime" / "wps-debug-package" / "debug-package.json"
    debug_manifest.parent.mkdir(parents=True)
    debug_manifest.write_text(json.dumps({"build_id": "test-build", "critical_assets": {}}), encoding="utf-8")
    monkeypatch.setattr(main, "ROOT", repository)
    monkeypatch.setattr(main, "DEBUG_MANIFEST", debug_manifest)
    monkeypatch.setattr(main, "RESOURCE_PROBE", repository / ".runtime" / "resource-probe.json")
    events = []
    monkeypatch.setattr(main, "log_event", lambda *args, **kwargs: events.append((args, kwargs)))

    def served(path: str) -> dict[str, object]:
        content = (build_root / path).read_bytes()
        content_type = "text/html; charset=utf-8" if path == "index.html" else "application/javascript; charset=utf-8"
        return {"path": path, "status": 200, "content_type": content_type, "content_length": len(content), "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(), "content": content, "text": content.decode("utf-8", errors="replace")}

    monkeypatch.setattr(main, "fetch_resource", served)
    report = main.probe_debug_server()
    assert report["status"] == "PASS"
    assert any(kwargs.get("component") == "debug_server" for _, kwargs in events)

    def served_mismatch(path: str) -> dict[str, object]:
        value = served(path)
        if path == "index.html":
            content = value["content"] + b"<script src='/hot-update-inject.js'></script>"
            value.update({"content": content, "bytes": len(content), "content_length": len(content), "sha256": hashlib.sha256(content).hexdigest(), "text": content.decode("utf-8")})
        return value

    monkeypatch.setattr(main, "fetch_resource", served_mismatch)
    report = main.probe_debug_server()
    assert report["status"] == "FAIL"
    assert "WPS_INDEX_RESPONSE_MISMATCH" in report["errors"]


def test_start_finalizes_build_before_resource_service() -> None:
    source = Path(main.__file__).read_text(encoding="utf-8")
    start = source.index('if args.action == "start":')
    end = source.index('elif args.action == "prepare":', start)
    block = source[start:end]
    assert block.index("verify()") < block.index("同步最终 WPS 调试包")
    assert block.index("同步最终 WPS 调试包") < block.index("ensure_control_server()")
    assert "register_addin(force_restart=True)" in block
