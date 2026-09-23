"""Own the Codex app-server process and keep its credentials current.

Codex caches the signed-in account inside the app-server process and refuses to
adopt a different account found on disk ("Skipping auth reload due to account id
mismatch"), so a long-lived app-server keeps failing every turn after ``codex
login`` switched accounts::

    Your access token could not be refreshed because you have since logged out or
    signed in to another account. Please sign in again.

Only a new app-server reads the new credentials, so this lifecycle compares the
account in ``auth.json`` before every operation and recycles the app-server as
soon as it changed.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path

from connector.logging import logger
from connector.runtimes.codex.notifications import CodexNotificationProjector
from connector.runtimes.codex.sdk.runtime_client import (
    CodexModelListResult,
    CodexNotificationMessage,
    CodexRuntimeClient,
)

AUTH_FILE_NAME = "auth.json"


@dataclass(slots=True)
class CodexRuntimeLifecycle:
    client: CodexRuntimeClient | None
    notifications: CodexNotificationProjector
    codex_home: str | None = None
    started: bool = False
    model_list_result: CodexModelListResult | None = None
    account_id: str | None = field(init=False, default=None)
    _start_lock: asyncio.Lock = field(
        init=False, default_factory=asyncio.Lock, repr=False
    )

    async def start(self) -> None:
        async with self._start_lock:
            if not self.started:
                # Remember the account before the app-server reads auth.json: a login
                # landing in between then shows up as a mismatch instead of hiding.
                self._remember_account()
                if self.client is not None:
                    await self.client.start(self.handle_notification)
                    await self.bootstrap()
                self.started = True
            await self.recycle_if_account_changed()

    async def stop(self) -> None:
        if self.client is not None:
            await self.client.stop()
        self.started = False

    async def bootstrap(self) -> None:
        if self.client is None:
            return
        try:
            self.model_list_result = await self.client.list_models()
        except Exception as exc:  # noqa: BLE001
            logger.debug("codex bootstrap read failed method=model/list error={}", exc)

    async def recycle_if_account_changed(self) -> bool:
        """Replace the app-server after ``codex login`` switched accounts.

        Runs before every Codex operation and returns True when the app-server was
        recycled. A credential refresh for the same account keeps it running.
        """

        if self.client is None or not self.started or self.codex_home is None:
            return False
        current = read_codex_account_id(self.codex_home)
        if current is None or current == self.account_id:
            return False
        restart = getattr(self.client, "restart", None)
        if not callable(restart):
            return False
        logger.info(
            "codex account changed on disk; restarting app-server previous={} current={}",
            self.account_id,
            current,
        )
        try:
            await restart()
        except Exception as exc:  # noqa: BLE001
            logger.warning("codex app-server restart failed error={}", exc)
            return False
        self.account_id = current
        self.model_list_result = None
        await self.bootstrap()
        return True

    async def handle_notification(self, message: CodexNotificationMessage) -> None:
        await self.notifications.handle(message)

    def _remember_account(self) -> None:
        self.account_id = read_codex_account_id(self.codex_home)


def read_codex_account_id(codex_home: str | None) -> str | None:
    """Read the signed-in ChatGPT account id from ``auth.json``."""

    if codex_home is None:
        return None
    try:
        payload = json.loads((Path(codex_home) / AUTH_FILE_NAME).read_text("utf-8"))
    except (OSError, ValueError):
        return None
    tokens = payload.get("tokens") if isinstance(payload, dict) else None
    account_id = tokens.get("account_id") if isinstance(tokens, dict) else None
    return account_id if isinstance(account_id, str) and account_id else None
