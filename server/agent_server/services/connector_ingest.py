from __future__ import annotations

from agent_server.core.models import ConnectorIngestRequest, ConnectorIngestResponse
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.shell_tasks import ShellTaskManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.infra.terminal_stream_hub import TerminalStreamHub
from agent_server.core.utc import utc_now
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.device_runtimes import DeviceRuntimeService


class ConnectorIngestService:
    def __init__(
        self,
        store: Store,
        tasks: ShellTaskManager,
        terminal_broker: TerminalBroker,
        terminal_stream_hub: TerminalStreamHub,
        timeline_broker: TimelineBroker,
        device_runtimes: DeviceRuntimeService,
    ) -> None:
        self._store = store
        self._tasks = tasks
        self._terminal_broker = terminal_broker
        self._terminal_stream_hub = terminal_stream_hub
        self._timeline_broker = timeline_broker
        self._device_runtimes = device_runtimes

    async def ingest(
        self,
        *,
        connector_id: str,
        payload: ConnectorIngestRequest,
    ) -> ConnectorIngestResponse:
        from agent_server.api.connector_ingress import apply_connector_notification, _publish_effects

        await self._store.record_connector_activity(connector_id)
        effects = []
        saw_protocol_capabilities = False
        saw_protocol_catalog = False
        saw_runtime_inventory = False
        for notification in payload.notifications:
            if notification.method == "runtime.inventoryUpdated":
                await self._device_runtimes.ingest_inventory(connector_id, notification.params)
                saw_runtime_inventory = True
                continue
            if notification.method == "runtime.statusChanged":
                await self._apply_runtime_status(connector_id, notification.params)
                continue
            if notification.method == "protocol.capabilitiesUpdated":
                saw_protocol_capabilities = True
            elif notification.method in {
                "protocol.modelCatalogUpdated",
                "protocol.permissionCatalogUpdated",
            }:
                saw_protocol_catalog = True
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
        if saw_protocol_capabilities or saw_protocol_catalog:
            await publish_dashboard_changed(
                self._store,
                self._timeline_broker,
                connector_id=connector_id,
                reason="protocol.catalog"
                if saw_protocol_catalog
                else "protocol.capabilities"
                if saw_protocol_capabilities
                else "protocol.capabilities",
            )
        if saw_runtime_inventory:
            import asyncio

            asyncio.create_task(self._device_runtimes.reconcile_active(connector_id))
        return ConnectorIngestResponse(accepted=len(payload.notifications), serverTime=utc_now())

    async def handle_notification_message(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict,
    ) -> None:
        from agent_server.api.connector_ingress import apply_connector_notification, _publish_effects

        if method == "runtime.inventoryUpdated":
            await self._device_runtimes.ingest_inventory(connector_id, params)
            import asyncio

            asyncio.create_task(self._device_runtimes.reconcile_active(connector_id))
            return
        if method == "runtime.statusChanged":
            await self._apply_runtime_status(connector_id, params)
            return

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
        if method in {
            "protocol.capabilitiesUpdated",
            "protocol.modelCatalogUpdated",
            "protocol.permissionCatalogUpdated",
        }:
            import asyncio

            await publish_dashboard_changed(
                self._store,
                self._timeline_broker,
                connector_id=connector_id,
                reason="protocol.catalog"
                if method in {"protocol.modelCatalogUpdated", "protocol.permissionCatalogUpdated"}
                else "protocol.capabilities"
                if method == "protocol.capabilitiesUpdated"
                else "protocol.capabilities",
            )

    async def _apply_runtime_status(self, connector_id: str, params: dict) -> None:
        runtime_id = params.get("runtimeId")
        status = params.get("status")
        if not isinstance(runtime_id, str) or not runtime_id:
            raise ValueError("runtime.statusChanged requires runtimeId")
        if not isinstance(status, str) or not status:
            raise ValueError("runtime.statusChanged requires status")
        error = params.get("error") if isinstance(params.get("error"), dict) else None
        await self._device_runtimes.apply_status(
            connector_id,
            runtime_id,
            status,
            error=error,
        )
