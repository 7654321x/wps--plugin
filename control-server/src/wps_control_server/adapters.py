"""Explicit adapter registrations for the Control Server.

Recognition stays deliberately unconfigured until the existing signed runtime
can return the frozen RecognitionResult directly.  Formatting can already
reuse the repository's pure command-builder core because that core has no
HTTP, WPS, or recognition-wheel dependency.
"""

from __future__ import annotations

from typing import Any, Dict

from .contracts import ContractError
from .ports import CancellationToken, FormattingPlannerPort, UnavailableFormattingPlannerPort


class LocalFormattingPlannerPort:
    available = True

    def plan(self, recognition: Dict[str, Any], request: Dict[str, Any], cancellation: CancellationToken) -> Dict[str, Any]:
        cancellation.raise_if_cancelled()
        try:
            from docxtool_command_service.core.command_builder import build_formatting_commands
        except ImportError as exc:
            raise ContractError("CONTROL_SERVER_FORMATTING_ADAPTER_NOT_CONFIGURED") from exc
        capabilities = request.get("client_capabilities")
        if not isinstance(capabilities, dict):
            raise ContractError("CONTROL_SERVER_CAPABILITIES_INVALID")
        command_request = {
            "schema_version": "1.0",
            "request_id": request["request_id"],
            "recognition_result": recognition,
            "profile_id": request["profile_id"],
            "profile_version": request["profile_version"],
            "client_capabilities": capabilities,
            "product_version": "1.4.3",
            "authorization_scope": "classified-offline",
        }
        try:
            result = build_formatting_commands(command_request)
        except Exception as exc:  # noqa: BLE001 - core errors become a stable boundary error
            code = str(exc)
            raise ContractError(code if code.isupper() else "FORMATTING_PLAN_INVALID") from exc
        cancellation.raise_if_cancelled()
        if not isinstance(result, dict):
            raise ContractError("FORMATTING_PLAN_INVALID")
        return result


def default_formatting_planner() -> FormattingPlannerPort:
    try:
        from docxtool_command_service.core.command_builder import build_formatting_commands  # noqa: F401
    except ImportError:
        return UnavailableFormattingPlannerPort()
    return LocalFormattingPlannerPort()
