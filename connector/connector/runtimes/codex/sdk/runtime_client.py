from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any, Protocol

from connector.runtimes.codex.sdk.events import CodexSdkEvent

CodexNotificationMessage = CodexSdkEvent | dict[str, Any]
NotificationHandler = Callable[[CodexNotificationMessage], Awaitable[None]]


class CodexRuntimeClient(Protocol):
    async def start(self, handler: NotificationHandler) -> None: ...
    async def stop(self) -> None: ...
    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]: ...
    async def respond(
        self,
        request_id: str | int,
        result: Mapping[str, Any] | None = None,
    ) -> None: ...
