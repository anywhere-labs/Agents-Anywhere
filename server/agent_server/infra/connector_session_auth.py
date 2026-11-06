"""Authorization snapshot owned by one authenticated base connection."""

from __future__ import annotations

import asyncio
import hashlib
import secrets
import time
from collections.abc import Awaitable, Callable

from agent_server.infra.connector_control_log import control_log, error_fields
from agent_server.infra.connector_mesh_auth import ConnectorCredentialCache


class ConnectorSessionAuthorization:
    def __init__(self, connector_id: str, connection_id: str, credential_digest: str,
                 cache: ConnectorCredentialCache, is_current: Callable[[], Awaitable[bool]],
                 disconnect: Callable[[], Awaitable[object]]) -> None:
        self.connector_id, self.connection_id = connector_id, connection_id
        self._digest, self._cache = credential_digest, cache
        self._is_current, self._disconnect = is_current, disconnect
        self._changed = asyncio.Condition()
        self._valid_until = 0.0
        self.reason: str | None = None
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._run(), name=f"connector-auth-{self.connection_id}")

    async def _update(self, reason: str | None) -> None:
        async with self._changed:
            self.reason = reason
            self._valid_until = time.monotonic() + 1
            self._changed.notify_all()

    async def valid(self) -> bool:
        if not self._cache.healthy:
            return False
        async with self._changed:
            await self._changed.wait_for(lambda: self.reason is not None or time.monotonic() < self._valid_until)
            return self.reason is None and self._cache.healthy

    async def _run(self) -> None:
        try:
            while True:
                async with asyncio.timeout(5):
                    fingerprint = await self._cache.get(self.connector_id)
                    reason = None
                    if not fingerprint:
                        reason = "credential_revoked"
                    elif not secrets.compare_digest(hashlib.sha256(fingerprint.encode()).hexdigest(), self._digest):
                        reason = "credential_changed"
                    elif not await self._is_current():
                        reason = "base_connection_changed"
                await self._update(reason)
                if reason is not None:
                    break
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            await self._update("base_connection_closed")
            raise
        except Exception as error:  # noqa: BLE001 - failed checks terminate this exact session
            await self._update("authorization_unavailable")
            control_log("session.auth_failed", level="WARNING", connectorId=self.connector_id,
                        connectionId=self.connection_id, **error_fields(error))
        control_log("session.auth_rejected", level="WARNING", connectorId=self.connector_id,
                    connectionId=self.connection_id, reason=self.reason)
        try:
            async with asyncio.timeout(5):
                await self._disconnect()
        except Exception as error:  # noqa: BLE001 - rejection must not leave an unobserved background failure
            control_log("session.auth_close_failed", level="WARNING", connectorId=self.connector_id,
                        connectionId=self.connection_id, **error_fields(error))

    async def close(self) -> None:
        if self._task is not None:
            # An invalid session may already be deleting its lease. Let that
            # conditional disconnect complete rather than interrupting cleanup.
            if self.reason is None:
                self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
