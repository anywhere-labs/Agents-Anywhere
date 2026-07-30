from __future__ import annotations

from typing import Any

from agent_server.core.models import ConnectorIngestRequest, ConnectorIngestResponse
from agent_server.core.utc import utc_now
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.connector_notifications import ConnectorNotificationService
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_runtimes import DeviceRuntimeService
from agent_server.services.ingest_effects import IngestEffect


class ConnectorIngestService:
    def __init__(
        self,
        store: Store,
        notifications: ConnectorNotificationService,
        timeline_broker: TimelineBroker,
        device_runtimes: DeviceRuntimeService,
    ) -> None:
        self._store = store
        self._notifications = notifications
        self._timeline_broker = timeline_broker
        self._device_runtimes = device_runtimes

    async def ingest(
        self,
        *,
        connector_id: str,
        payload: ConnectorIngestRequest,
    ) -> ConnectorIngestResponse:
        await self._store.record_connector_activity(connector_id)
        effects = []
        saw_protocol_capabilities = False
        saw_protocol_catalog = False
        saw_runtime_inventory = False
        for notification in payload.notifications:
            if notification.method == "runtime.inventoryUpdated":
                await self._device_runtimes.ingest_inventory(
                    connector_id, notification.params
                )
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
                await self._notifications.apply(
                    connector_id=connector_id,
                    method=notification.method,
                    params=notification.params,
                )
            )
        await self._publish_effects(effects)
        if saw_protocol_capabilities or saw_protocol_catalog:
            await publish_dashboard_changed(
                self._store,
                self._timeline_broker,
                connector_id=connector_id,
                reason="protocol.catalog"
                if saw_protocol_catalog
                else "protocol.capabilities",
            )
        if saw_runtime_inventory:
            import asyncio

            asyncio.create_task(self._device_runtimes.reconcile_active(connector_id))
        return ConnectorIngestResponse(
            accepted=len(payload.notifications), serverTime=utc_now()
        )

    async def handle_notification_message(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict,
    ) -> None:
        if method == "runtime.inventoryUpdated":
            await self._device_runtimes.ingest_inventory(connector_id, params)
            import asyncio

            asyncio.create_task(self._device_runtimes.reconcile_active(connector_id))
            return
        if method == "runtime.statusChanged":
            await self._apply_runtime_status(connector_id, params)
            return

        effect = await self._notifications.apply(
            connector_id=connector_id,
            method=method,
            params=params,
        )
        await self._publish_effects([effect])
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
                if method
                in {"protocol.modelCatalogUpdated", "protocol.permissionCatalogUpdated"}
                else "protocol.capabilities",
            )

    async def _publish_effects(self, effects: list[IngestEffect]) -> None:
        by_session: dict[str, dict[str, Any]] = {}
        for effect in effects:
            if effect.session_id is None:
                continue
            bucket = by_session.setdefault(
                effect.session_id,
                {
                    "items": [],
                    "session": False,
                    "approvals": False,
                    "notices": False,
                    "refetch": False,
                },
            )
            if effect.item is not None:
                bucket["items"].append(effect.item)
            if effect.items:
                bucket["items"].extend(effect.items)
            bucket["session"] = bucket["session"] or effect.session_changed
            bucket["approvals"] = bucket["approvals"] or effect.approvals_changed
            bucket["notices"] = bucket["notices"] or effect.notices_changed
            bucket["refetch"] = bucket["refetch"] or effect.needs_refetch

        for session_id, bucket in by_session.items():
            try:
                next_seq = await self._store.get_session_seq(session_id)
            except KeyError:
                continue
            envelope: dict[str, Any] = {
                "sessionId": session_id,
                "nextSeq": next_seq,
            }
            if bucket["refetch"]:
                envelope["refetch"] = True
            if bucket["items"]:
                envelope["items"] = bucket["items"]
            if bucket["session"]:
                try:
                    envelope["session"] = (
                        await self._store.get_session(session_id)
                    ).model_dump(mode="json")
                except KeyError:
                    pass
            if bucket["approvals"]:
                envelope["approvals"] = [
                    approval.model_dump(mode="json")
                    for approval in await self._store.list_pending_approvals(session_id)
                ]
            if bucket["notices"]:
                envelope["notices"] = [
                    notice.model_dump(mode="json")
                    for notice in await self._store.list_open_notices(session_id)
                ]
            await self._timeline_broker.publish(session_id, envelope)
            await publish_dashboard_changed(
                self._store,
                self._timeline_broker,
                session_id=session_id,
                reason="session.changed",
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
