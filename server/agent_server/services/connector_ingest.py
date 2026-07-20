from __future__ import annotations

from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.core.models import ConnectorIngestRequest, ConnectorIngestResponse
from agent_server.services.runtime_activation import send_active_runtimes
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.shell_tasks import ShellTaskManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.infra.terminal_stream_hub import TerminalStreamHub
from agent_server.core.utc import utc_now
from agent_server.infra.timeline_broker import TimelineBroker


class ConnectorIngestService:
    def __init__(
        self,
        store: Store,
        manager: ConnectorRpcManager,
        tasks: ShellTaskManager,
        terminal_broker: TerminalBroker,
        terminal_stream_hub: TerminalStreamHub,
        timeline_broker: TimelineBroker,
    ) -> None:
        self._store = store
        self._manager = manager
        self._tasks = tasks
        self._terminal_broker = terminal_broker
        self._terminal_stream_hub = terminal_stream_hub
        self._timeline_broker = timeline_broker

    async def ingest(
        self,
        *,
        connector_id: str,
        payload: ConnectorIngestRequest,
    ) -> ConnectorIngestResponse:
        from agent_server.api.connector_ingress import apply_connector_notification, _publish_effects

        await self._store.record_connector_activity(connector_id)
        effects = []
        saw_discovery_capabilities = False
        saw_protocol_capabilities = False
        for notification in payload.notifications:
            if notification.method == "connector.capabilitiesUpdated":
                saw_discovery_capabilities = True
            elif notification.method == "protocol.capabilitiesUpdated":
                saw_protocol_capabilities = True
            effects.append(
                await apply_connector_notification(
                    connector_id,
                    notification.method,
                    notification.params,
                    self._store,
                    self._tasks,
                    self._terminal_broker,
                    self._terminal_stream_hub,
                )
            )
        await _publish_effects(self._store, self._timeline_broker, effects)
        if saw_discovery_capabilities or saw_protocol_capabilities:
            await publish_dashboard_changed(
                self._store,
                self._timeline_broker,
                connector_id=connector_id,
                reason="protocol.capabilities" if saw_protocol_capabilities else "connector.capabilities",
            )
        if saw_discovery_capabilities:
            await send_active_runtimes(self._manager, self._store, connector_id)
        return ConnectorIngestResponse(accepted=len(payload.notifications), serverTime=utc_now())

    async def handle_notification_message(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict,
    ) -> None:
        from agent_server.api.connector_ingress import apply_connector_notification, _publish_effects

        effect = await apply_connector_notification(
            connector_id,
            method,
            params,
            self._store,
            self._tasks,
            self._terminal_broker,
            self._terminal_stream_hub,
        )
        await _publish_effects(self._store, self._timeline_broker, [effect])
        if method in {"connector.capabilitiesUpdated", "protocol.capabilitiesUpdated"}:
            import asyncio

            await publish_dashboard_changed(
                self._store,
                self._timeline_broker,
                connector_id=connector_id,
                reason="protocol.capabilities"
                if method == "protocol.capabilitiesUpdated"
                else "connector.capabilities",
            )
            if method == "connector.capabilitiesUpdated":
                asyncio.create_task(send_active_runtimes(self._manager, self._store, connector_id))
