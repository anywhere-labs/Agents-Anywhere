from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from connector.logging import logger
from connector.runtimes.codex.notifications import CodexNotificationProjector
from connector.runtimes.codex.runtime_client import CodexRuntimeClient


@dataclass(slots=True)
class CodexRuntimeLifecycle:
    client: CodexRuntimeClient | None
    notifications: CodexNotificationProjector
    started: bool = False
    model_list_result: dict[str, Any] | None = None

    async def start(self) -> None:
        if self.started:
            return
        if self.client is not None:
            await self.client.start(self.handle_notification)
            await self.bootstrap()
        self.started = True

    async def stop(self) -> None:
        if self.client is not None:
            await self.client.stop()
        self.started = False

    async def bootstrap(self) -> None:
        if self.client is None:
            return
        for method in ("model/list", "thread/loaded/list"):
            try:
                result = await self.client.request(method)
            except Exception as exc:  # noqa: BLE001
                logger.debug(
                    "codex bootstrap read failed method={} error={}", method, exc
                )
                continue
            if method == "model/list":
                self.model_list_result = result

    async def handle_notification(self, message: dict[str, Any]) -> None:
        await self.notifications.handle(message)
