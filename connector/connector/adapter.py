from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Protocol, runtime_checkable


NotificationSink = Callable[[str, dict[str, Any]], Awaitable[None]] | None


@runtime_checkable
class Adapter(Protocol):
    """Per-runtime backend client (Codex / Claude / OpenCode / ACP).

    `BackendRpcClient` holds a dict of these keyed by runtime name and routes
    incoming RPCs by `params["runtime"]`. Every adapter must accept a
    `notification_sink` for pushing reduced backend notifications upstream
    (set after construction by the client).
    """

    notification_sink: NotificationSink

    async def create_session(self, params: dict[str, Any]) -> dict[str, Any]: ...

    async def sync_session(self, params: dict[str, Any]) -> dict[str, Any]: ...

    async def sync_existing_sessions(
        self,
        connector_id: str,
        *,
        limit: int = 100,
        force: bool = False,
        notification_sink: Callable[[list[dict[str, Any]]], Awaitable[None]] | None = None,
    ) -> dict[str, Any]: ...

    async def start_turn(self, params: dict[str, Any]) -> dict[str, Any]: ...

    async def interrupt_turn(self, params: dict[str, Any]) -> dict[str, Any]: ...

    async def resolve_approval(self, params: dict[str, Any]) -> dict[str, Any]: ...
