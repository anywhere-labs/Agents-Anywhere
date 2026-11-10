from __future__ import annotations

from typing import Any, Protocol

from connector.runtime_protocol.planning import NativePlanningResult


class PlanningRuntimePort(Protocol):
    async def available(self, session_id: str, external_id: str | None) -> bool: ...
    async def read_mode(self, session_id: str, external_id: str | None) -> str: ...
    async def change_mode(
        self, session_id: str, external_id: str | None, mode: str
    ) -> NativePlanningResult: ...
    async def submit(
        self, session_id: str, external_id: str | None, request: dict[str, Any]
    ) -> NativePlanningResult: ...
    async def review_is_current(
        self,
        session_id: str,
        external_id: str | None,
        proposal: dict,
        native: dict | None,
    ) -> bool: ...
    async def review(
        self,
        session_id: str,
        external_id: str | None,
        proposal: dict,
        native: dict | None,
        action: str,
        feedback: str,
        operation_id: str,
    ) -> NativePlanningResult: ...


class PlanningStateStore(Protocol):
    def unpublished(self, session_id: str) -> list[dict]: ...
    def mark_published(self, session_id: str, document: dict) -> None: ...
    def load(self, session_id: str) -> dict | None: ...
    def operation(
        self, session_id: str, operation_id: str
    ) -> tuple[str, dict] | None: ...
    def save(
        self, state: dict, operation: tuple[str, str, dict] | None = None
    ) -> None: ...
