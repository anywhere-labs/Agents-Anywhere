"""Retryable cleanup after a user requests permanent Connector deletion."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from loguru import logger

from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.repository_ports import ConnectorDeletionRepository

if TYPE_CHECKING:
    from agent_server.infra.connector_rpc import ConnectorRpcManager
    from agent_server.infra.terminal_broker import TerminalBroker
    from agent_server.infra.timeline_broker import TimelineBroker
    from agent_server.services.session_runtime_state_cache import (
        SessionRuntimeStateCache,
    )
    from agent_server.services.timeline_write_buffer import TimelineWriteBuffer


async def delete_connector_data(
    connector_id: str,
    user_id: str,
    store: ConnectorDeletionRepository,
    manager: ConnectorRpcManager,
    terminals: TerminalBroker,
    timeline_buffer: TimelineWriteBuffer,
    runtime_state_cache: SessionRuntimeStateCache,
) -> None:
    async with store.connector_lifecycle(connector_id):
        session_ids = await store.begin_connector_deletion(
            connector_id, user_id=user_id
        )
        await manager.disconnect(connector_id, reason="connector deleted")
        await terminals.remove_for_connector(connector_id)
        for session_id in session_ids:
            await timeline_buffer.discard_session(session_id)
            await runtime_state_cache.discard(session_id)
        await store.delete_connector(connector_id, user_id=user_id)


class ConnectorDeletionRecovery:
    def __init__(
        self,
        store: ConnectorDeletionRepository,
        manager: ConnectorRpcManager,
        terminals: TerminalBroker,
        timeline_buffer: TimelineWriteBuffer,
        runtime_state_cache: SessionRuntimeStateCache,
        broker: TimelineBroker,
    ) -> None:
        self._store = store
        self._manager = manager
        self._terminals = terminals
        self._timeline_buffer = timeline_buffer
        self._runtime_state_cache = runtime_state_cache
        self._broker = broker

    async def run_once(self) -> None:
        # Only explicit pending deletions (2), never legacy revoked credentials (1).
        for connector_id, user_id in await self._store.pending_connector_deletions():
            try:
                await delete_connector_data(
                    connector_id,
                    user_id,
                    self._store,
                    self._manager,
                    self._terminals,
                    self._timeline_buffer,
                    self._runtime_state_cache,
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
