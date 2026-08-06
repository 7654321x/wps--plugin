"""Stable internal ports and cancellation primitives."""

from __future__ import annotations

import threading
from typing import Any, Callable, Dict, Protocol

from .contracts import ContractError


class CancellationToken:
    def __init__(self) -> None:
        self._event = threading.Event()

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise ContractError("PIPELINE_CANCELLED")


class RecognitionPort(Protocol):
    def recognize(self, snapshot: Dict[str, Any], cancellation: CancellationToken) -> Dict[str, Any]:
        ...


class FormattingPlannerPort(Protocol):
    def plan(self, recognition: Dict[str, Any], request: Dict[str, Any], cancellation: CancellationToken) -> Dict[str, Any]:
        ...


class UnavailableRecognitionPort:
    """Explicit safe default until the installed runtime is assembled."""

    available = False

    def recognize(self, snapshot: Dict[str, Any], cancellation: CancellationToken) -> Dict[str, Any]:
        cancellation.raise_if_cancelled()
        raise ContractError("CONTROL_SERVER_RECOGNITION_ADAPTER_NOT_CONFIGURED")


class UnavailableFormattingPlannerPort:
    available = False

    def plan(self, recognition: Dict[str, Any], request: Dict[str, Any], cancellation: CancellationToken) -> Dict[str, Any]:
        cancellation.raise_if_cancelled()
        raise ContractError("CONTROL_SERVER_FORMATTING_ADAPTER_NOT_CONFIGURED")


class CallableRecognitionPort:
    """Test/development adapter; production registration remains explicit."""

    available = True

    def __init__(self, callback: Callable[[Dict[str, Any], CancellationToken], Dict[str, Any]]) -> None:
        self._callback = callback

    def recognize(self, snapshot: Dict[str, Any], cancellation: CancellationToken) -> Dict[str, Any]:
        value = self._callback(snapshot, cancellation)
        if not isinstance(value, dict):
            raise ContractError("RECOGNITION_RESULT_INVALID")
        return value


class CallableFormattingPlannerPort:
    available = True

    def __init__(self, callback: Callable[[Dict[str, Any], Dict[str, Any], CancellationToken], Dict[str, Any]]) -> None:
        self._callback = callback

    def plan(self, recognition: Dict[str, Any], request: Dict[str, Any], cancellation: CancellationToken) -> Dict[str, Any]:
        value = self._callback(recognition, request, cancellation)
        if not isinstance(value, dict):
            raise ContractError("FORMATTING_PLAN_INVALID")
        return value
