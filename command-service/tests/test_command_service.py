import io
import json
import sys
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from wsgiref.simple_server import make_server
from wsgiref.util import setup_testing_defaults

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from docxtool_command_service.api.app import create_app  # noqa: E402
from docxtool_command_service.core.command_builder import build_formatting_commands  # noqa: E402
from docxtool_command_service.core.validation import (  # noqa: E402
    CommandServiceError,
    validate_command,
    validate_command_request,
)


SHA = "a" * 64


def request_payload():
    return {
        "schema_version": "1.0",
        "request_id": "request-00000001",
        "recognition_result": {
            "schema_version": "1.0",
            "recognition_engine_version": "3.0",
            "document_id": "doc-1",
            "document_revision": "rev-1",
            "source_sha256": SHA,
            "document_mode": "normal",
            "document_mode_confidence": 1.0,
            "paragraphs": [{
                "target_id": "doc-1:p:0:0",
                "source_paragraph_index": 0,
                "recognized_type": "body",
                "section_kind": "body",
                "text_sha256": SHA,
                "text_length": 8,
                "occurrence_index": 0,
                "confidence": 1.0,
                "review_level": "confirmed",
                "needs_review": False,
            }],
        },
        "profile_id": "default",
        "profile_version": "1.0",
        "client_capabilities": {
            "schema_version": "1.0",
            "capabilities": [
                "paragraph.font", "paragraph.alignment", "paragraph.indent",
                "paragraph.spacing", "section.page_setup", "transaction.undo",
            ],
        },
        "product_version": "0.1.0",
        "authorization_scope": "classified-offline",
    }


def _serve(app):
    server = make_server("127.0.0.1", 0, app)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def _post(server, headers):
    body = json.dumps(request_payload()).encode("utf-8")
    request = Request(
        "http://127.0.0.1:%d/v1/commands" % server.server_port,
        data=body,
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    with urlopen(request) as response:
        return json.loads(response.read().decode("utf-8"))


def test_pure_core_and_local_cloud_http_produce_identical_commands():
    direct = build_formatting_commands(request_payload())
    local, _ = _serve(create_app("local", "local-token"))
    cloud, _ = _serve(create_app("cloud", "cloud-token"))
    try:
        local_result = _post(local, {"X-Docxtool-Session": "local-token"})
        cloud_result = _post(cloud, {"Authorization": "Bearer cloud-token"})
    finally:
        local.shutdown()
        cloud.shutdown()
    assert local_result == direct
    assert cloud_result == direct
    assert [item["kind"] for item in direct["commands"]] == [
        "section.set_page_setup", "paragraph.set_font", "paragraph.set_alignment",
        "paragraph.set_indent", "paragraph.set_spacing",
    ]


def test_title_continuation_uses_the_frozen_main_title_profile():
    payload = request_payload()
    payload["recognition_result"]["paragraphs"][0]["recognized_type"] = "title_continuation"
    commands = build_formatting_commands(payload)["commands"]
    font = next(item for item in commands if item["kind"] == "paragraph.set_font")
    alignment = next(item for item in commands if item["kind"] == "paragraph.set_alignment")
    assert font["arguments"]["east_asia_font_name"] == "方正小标宋简体"
    assert font["arguments"]["font_size_pt"] == 22
    assert alignment["arguments"]["alignment"] == "center"


def test_http_requires_the_mode_specific_authentication():
    server, _ = _serve(create_app("local", "local-token"))
    try:
        with pytest.raises(HTTPError) as exc_info:
            _post(server, {"X-Docxtool-Session": "wrong"})
        assert exc_info.value.code == 401
    finally:
        server.shutdown()


def test_cors_preflight_allows_only_fixed_taskpane_origin():
    environ = {}
    setup_testing_defaults(environ)
    environ.update(REQUEST_METHOD="OPTIONS", PATH_INFO="/v1/commands", HTTP_ORIGIN="http://127.0.0.1:3889", wsgi_input=io.BytesIO())
    captured = {}
    body = b"".join(create_app("local", "local-token")(environ, lambda status, headers: captured.update(status=status, headers=dict(headers))))
    assert body == b"{}"
    assert captured["status"] == "204 No Content"
    assert captured["headers"]["Access-Control-Allow-Origin"] == "http://127.0.0.1:3889"
    assert "Authorization" in captured["headers"]["Access-Control-Allow-Headers"]
    environ["HTTP_ORIGIN"] = "https://example.invalid"
    create_app("local", "local-token")(environ, lambda status, headers: captured.update(status=status, headers=dict(headers)))
    assert "Access-Control-Allow-Origin" not in captured["headers"]


@pytest.mark.parametrize("field", [
    "text", "raw_text", "original_text", "paragraph_text", "document_content",
    "file_content", "file_base64", "local_path", "absolute_path", "javascript",
    "python_code", "script", "code",
])
def test_request_rejects_plaintext_paths_and_code(field):
    payload = request_payload()
    payload["recognition_result"]["paragraphs"][0][field] = "sensitive"
    with pytest.raises(CommandServiceError) as exc_info:
        validate_command_request(payload)
    assert exc_info.value.code == "SENSITIVE_FIELD_REJECTED"


def test_unsupported_schema_version_and_invalid_parameters_are_rejected():
    payload = request_payload()
    payload["schema_version"] = "9.0"
    with pytest.raises(CommandServiceError) as exc_info:
        validate_command_request(payload)
    assert exc_info.value.code == "UNSUPPORTED_SCHEMA_VERSION"

    command = build_formatting_commands(request_payload())["commands"][1]
    command["arguments"]["font_size_pt"] = 200
    with pytest.raises(CommandServiceError) as exc_info:
        validate_command(command)
    assert exc_info.value.code == "INVALID_PARAMETER"


def test_unknown_and_text_modification_commands_are_rejected():
    command = build_formatting_commands(request_payload())["commands"][1]
    command["kind"] = "text.replace"
    with pytest.raises(CommandServiceError) as exc_info:
        validate_command(command)
    assert exc_info.value.code == "UNKNOWN_COMMAND"


def test_contract_schema_files_are_present_and_closed_at_the_top_level():
    schemas = Path(__file__).resolve().parents[2] / "schemas"
    for name in (
        "recognition-result.schema.json", "command-request.schema.json",
        "formatting-command-set.schema.json", "client-capabilities.schema.json",
        "execution-result.schema.json",
    ):
        payload = json.loads((schemas / name).read_text(encoding="utf-8"))
        assert payload["additionalProperties"] is False
        assert payload["required"]


def test_pure_core_never_imports_docx_wheel_or_wps():
    core = (ROOT / "src" / "docxtool_command_service" / "core")
    source = "\n".join(path.read_text(encoding="utf-8") for path in core.glob("*.py"))
    assert "from docxtool" not in source
    assert "import docxtool" not in source
    assert "import docx" not in source
    assert "import win32" not in source
