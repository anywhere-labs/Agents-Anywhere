"""Retryable cleanup after a user requests permanent Connector deletion."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Protocol

from loguru import logger

from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.repository_ports import ConnectorDeletionRepository

if TYPE_CHECKING:
    from agent_server.infra.connector_rpc import ConnectorRpcManager
    from agent_server.infra.timeline_broker import TimelineBroker
    from agent_server.services.session_runtime_state_cache import (
        SessionRuntimeStateCache,
    )


class DeviceLinkRevoker(Protocol):
    """``DeviceLinkService``: ends a v3 device's link from any worker."""

    async def revoke(self, device_id: str, reason: str) -> None: ...


async def delete_connector_data(
    connector_id: str,
    user_id: str,
    store: ConnectorDeletionRepository,
    manager: ConnectorRpcManager,
    runtime_state_cache: SessionRuntimeStateCache,
    device_link: DeviceLinkRevoker,
) -> None:
    async with store.connector_lifecycle(connector_id):
        session_ids = await store.begin_connector_deletion(
            connector_id, user_id=user_id
        )
        # The v3 MeshCall link first (any worker may hold it), then a v2 WebSocket.
        await device_link.revoke(connector_id, "connector deleted")
        await manager.disconnect(connector_id, reason="connector deleted")
        for session_id in session_ids:
            await runtime_state_cache.discard(session_id)
        await store.delete_connector(connector_id, user_id=user_id)


class ConnectorDeletionRecovery:
    def __init__(
        self,
        store: ConnectorDeletionRepository,
        manager: ConnectorRpcManager,
        runtime_state_cache: SessionRuntimeStateCache,
        broker: TimelineBroker,
        device_link: DeviceLinkRevoker,
    ) -> None:
        self._store = store
        self._manager = manager
        self._runtime_state_cache = runtime_state_cache
        self._broker = broker
        self._device_link = device_link

    async def run_once(self) -> None:
        # Only explicit pending deletions (2), never legacy revoked credentials (1).
        for connector_id, user_id in await self._store.pending_connector_deletions():
            try:
                await delete_connector_data(
                    connector_id,
                    user_id,
                    self._store,
                    self._manager,
                    self._runtime_state_cache,
                    self._device_link,
                )
            except KeyError:
                continue  # A different worker completed the same deletion.
            except Exception as exc:  # noqa: BLE001 - retain pending deletion for retry
                logger.warning(
                    "connector deletion deferred connector_id={} error={}",
                    connector_id,
                    exc,
                )
                continue
            await publish_dashboard_changed(
                self._store,
                self._broker,
                user_id=user_id,
                connector_id=connector_id,
                reason="connector.deleted",
            )

    async def run(self) -> None:
        while True:
            try:
                await self.run_once()
            except Exception as exc:  # noqa: BLE001 - retain pending deletion for retry
                logger.warning("connector deletion recovery deferred error={}", exc)
            await asyncio.sleep(30)
