from __future__ import annotations

from typing import Any

from loguru import logger

from agent_server.core.models import (
    ConnectorIngestRejectedNotification,
    ConnectorIngestRequest,
    ConnectorIngestResponse,
    ConnectorNotification,
    SessionRuntimeState,
    SessionView,
)
from agent_server.core.runtime_identity import resolve_session_runtime_binding
from agent_server.core.utc import utc_now
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.connector_notifications import (
    ConnectorNotificationService,
    NotificationValidationError,
)
from agent_server.services.connector_presence import (
    ConnectorPresencePort,
    with_effective_session_connector_status,
)
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_runtimes import (
    DeviceRuntimeNotFoundError,
    DeviceRuntimeService,
)
from agent_server.services.effective_capabilities import (
    project_session_capabilities,
    publish_connector_session_capabilities,
)
from agent_server.services.ingest_effects import IngestEffect
from agent_server.services.repository_ports import ConnectorIngestRepository
from agent_server.services.session_runtime_state_cache import (
    SessionRuntimeStateCache,
)

INGEST_REJECTION_MESSAGE_MAX_LENGTH = 500


def ingest_rejection_from_exception(
    index: int,
    notification: ConnectorNotification,
    error: Exception,
) -> ConnectorIngestRejectedNotification:
    message = str(error) or type(error).__name__
    if len(message) > INGEST_REJECTION_MESSAGE_MAX_LENGTH:
        message = f"{message[:INGEST_REJECTION_MESSAGE_MAX_LENGTH].rstrip()}..."
    return ConnectorIngestRejectedNotification(
        index=index,
        method=notification.method,
        code="notification_failed",
        message=message,
        errorType=type(error).__name__,
    )


class ConnectorIngestService:
    def __init__(
        self,
        store: ConnectorIngestRepository,
        notifications: ConnectorNotificationService,
        timeline_broker: TimelineBroker,
        device_runtimes: DeviceRuntimeService,
        presence: ConnectorPresencePort,
        runtime_state_cache: SessionRuntimeStateCache,
    ) -> None:
        self._store = store
        self._notifications = notifications
        self._timeline_broker = timeline_broker
        self._device_runtimes = device_runtimes
        self._presence = presence
        self._runtime_state_cache = runtime_state_cache

    async def ingest(
        self,
        *,
        connector_id: str,
        payload: ConnectorIngestRequest,
    ) -> ConnectorIngestResponse:
        await self._store.record_connector_activity(connector_id)
        effects = []
        accepted = 0
        rejected: list[ConnectorIngestRejectedNotification] = []
        protocol_capabilities_changed = False
        runtime_scoped_capabilities_changed = False
        for index, notification in enumerate(payload.notifications):
            try:
                effect = await self.apply_ingest_notification(
                    connector_id,
                    notification,
                )
            except NotificationValidationError:
                raise
            except Exception as exc:  # noqa: BLE001
                rejected.append(
                    ingest_rejection_from_exception(
                        index,
                        notification,
                        exc,
                    )
                )
                logger.exception(
                    "connector ingest notification rejected connector_id={} index={} method={} error_type={}",
                    connector_id,
                    index,
                    notification.method,
                    type(exc).__name__,
                )
                continue
            accepted += 1
            if notification.method == "runtime.inventoryUpdated":
                continue
            if notification.method == "runtime.statusChanged":
                continue
            effects.append(effect)
            if notification.method == "protocol.capabilitiesUpdated":
                protocol_capabilities_changed = (
                    protocol_capabilities_changed or effect.protocol_changed
                )
            if notification.method == "runtime.capability.updated":
                runtime_scoped_capabilities_changed = (
                    runtime_scoped_capabilities_changed
                    or (
                        effect.protocol_changed
                        and not isinstance(notification.params.get("sessionId"), str)
                    )
                )
        dashboard_changed = await self._publish_effects(effects)
        if protocol_capabilities_changed:
            await publish_connector_session_capabilities(
                self._store,
                self._presence,
                self._timeline_broker,
                connector_id,
            )
        if runtime_scoped_capabilities_changed:
            await publish_connector_session_capabilities(
                self._store,
                self._presence,
                self._timeline_broker,
                connector_id,
            )
        if dashboard_changed:
            await publish_dashboard_changed(
                self._store,
                self._timeline_broker,
                connector_id=connector_id,
                reason="connector.ingest",
            )
        return ConnectorIngestResponse(
            accepted=accepted,
            rejected=rejected,
            serverTime=utc_now(),
        )

    async def apply_ingest_notification(
        self,
        connector_id: str,
        notification: ConnectorNotification,
    ) -> IngestEffect:
        """Apply one connector ingest notification.

        Side effects:
        - may write connector/runtime/session/timeline state
        - may update runtime inventory rows
        - does not publish session WebSocket effects; caller owns publication
        """
        if notification.method == "runtime.inventoryUpdated":
            await self._device_runtimes.ingest_unsolicited_inventory(
                connector_id,
                notification.params,
            )
            return IngestEffect()
        if notification.method == "runtime.statusChanged":
            await self._apply_runtime_status(connector_id, notification.params)
            return IngestEffect()
        return await self._notifications.apply(
            connector_id=connector_id,
            method=notification.method,
            params=notification.params,
        )

    async def handle_notification_message(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict,
    ) -> None:
        if method == "runtime.inventoryUpdated":
            await self._device_runtimes.ingest_unsolicited_inventory(
                connector_id,
                params,
            )
            return
        if method == "runtime.statusChanged":
            await self._apply_runtime_status(connector_id, params)
            return

        effect = await self._notifications.apply(
            connector_id=connector_id,
            method=method,
            params=params,
        )
        dashboard_changed = await self._publish_effects([effect])
        if method == "protocol.capabilitiesUpdated" and effect.protocol_changed:
            await publish_connector_session_capabilities(
                self._store,
                self._presence,
                self._timeline_broker,
                connector_id,
            )
        if (
            method == "runtime.capability.updated"
            and effect.protocol_changed
            and not isinstance(params.get("sessionId"), str)
        ):
            await publish_connector_session_capabilities(
                self._store,
                self._presence,
                self._timeline_broker,
                connector_id,
            )
        if dashboard_changed:
            await publish_dashboard_changed(
                self._store,
                self._timeline_broker,
                connector_id=connector_id,
                reason=method,
            )

    async def _publish_effects(self, effects: list[IngestEffect]) -> bool:
        dashboard_changed = any(effect.dashboard_changed for effect in effects)
        by_session: dict[str, dict[str, Any]] = {}
        for effect in effects:
            target_session_ids = []
            if effect.session_id is not None:
                target_session_ids.append(effect.session_id)
            if effect.session_ids:
                target_session_ids.extend(effect.session_ids)
            if not target_session_ids:
                continue
            for session_id in sorted(set(target_session_ids)):
                bucket = by_session.setdefault(
                    session_id,
                    {
                        "items": [],
                        "runtime_state": None,
                        "timeline_reset": False,
                        "session": False,
                        "capability_changed": False,
                        "notices": [],
                        "catalogs": {},
                        "refetch": False,
                        "deferred_timeline_only": True,
                        "accepted_sequence": None,
                    },
                )
                if not effect.timeline_pending:
                    bucket["deferred_timeline_only"] = False
                if effect.session_id == session_id:
                    if effect.accepted_sequence is not None:
                        current_accepted_sequence = bucket["accepted_sequence"]
                        bucket["accepted_sequence"] = max(
                            effect.accepted_sequence,
                            current_accepted_sequence or 0,
                        )
                    if effect.timeline_published:
                        pass
                    elif effect.timeline_reset and not effect.needs_refetch:
                        bucket["items"] = list(effect.items or [])
                        bucket["timeline_reset"] = True
                        bucket["refetch"] = False
                    elif effect.needs_refetch:
                        bucket["items"] = []
                        bucket["timeline_reset"] = False
                        bucket["refetch"] = True
                    elif effect.item is not None or effect.items:
                        if bucket["timeline_reset"] or bucket["refetch"]:
                            bucket["items"] = []
                            bucket["timeline_reset"] = False
                            bucket["refetch"] = True
                        else:
                            if effect.item is not None and not effect.timeline_published:
                                bucket["items"].append(effect.item)
                            if effect.items:
                                bucket["items"].extend(effect.items)
                    if effect.runtime_state is not None:
                        bucket["runtime_state"] = effect.runtime_state
                    bucket["session"] = bucket["session"] or effect.session_changed
                    bucket["capability_changed"] = (
                        bucket["capability_changed"] or effect.protocol_changed
                    )
                    if effect.notices:
                        bucket["notices"].extend(effect.notices)
                if effect.catalogs:
                    bucket["catalogs"].update(effect.catalogs)

        async def publish_bucket(
            session_id: str,
            bucket: dict[str, Any],
        ) -> bool:
            status_changed = False
            try:
                next_seq = await self._store.get_session_seq(session_id)
            except KeyError:
                return False
            if bucket["accepted_sequence"] is not None:
                next_seq = max(next_seq, bucket["accepted_sequence"])
            envelope_sequence = (
                max(next_seq, 1)
                if bucket["notices"] or bucket["catalogs"]
                else next_seq
            )
            envelope: dict[str, Any] = {
                "sessionId": session_id,
                "nextSeq": envelope_sequence,
            }
            if bucket["refetch"]:
                envelope["refetch"] = True
            elif bucket["timeline_reset"]:
                envelope["timelineReset"] = True
                envelope["items"] = bucket["items"]
            elif bucket["items"]:
                envelope["items"] = bucket["items"]
            runtime_state: SessionRuntimeState | None = None
            if bucket["runtime_state"]:
                bound_session = await self._store.get_session(session_id)
                runtime_state = runtime_state_from_ingest_effect(
                    bound_session,
                    next_seq,
                    bucket["runtime_state"],
                )
                previous_runtime_state = await self._runtime_state_cache.get(session_id)
                if runtime_states_semantically_equal(
                    previous_runtime_state,
                    runtime_state,
                ):
                    runtime_state = None
                else:
                    if (
                        previous_runtime_state is None
                        or previous_runtime_state.status != runtime_state.status
                    ):
                        logger.info(
                            "session_status_trace layer=server session_id={} runtime={} "
                            "runtime_id={} previous_status={} next_status={} source={} "
                            "previous_updated_seq={} ingest_next_seq={}",
                            session_id,
                            runtime_state.runtime,
                            runtime_state.runtimeId,
                            previous_runtime_state.status
                            if previous_runtime_state is not None
                            else None,
                            runtime_state.status,
                            runtime_state.metadata.get("source"),
                            previous_runtime_state.updatedSeq
                            if previous_runtime_state is not None
                            else None,
                            next_seq,
                        )
                    persisted_session = await self._store.set_session_status(
                        session_id,
                        runtime_state.status,
                        mark_read_on_change=True,
                    )
                    status_changed = persisted_session.status != bound_session.status
                    next_seq = max(
                        await self._store.get_session_seq(session_id),
                        persisted_session.updatedSeq,
                    )
                    envelope["nextSeq"] = max(envelope_sequence, next_seq)
                    runtime_state = runtime_state.model_copy(
                        update={"updatedSeq": envelope["nextSeq"]}
                    )
                    await self._runtime_state_cache.put(runtime_state)
                    envelope["runtimeState"] = runtime_state.model_dump(mode="json")
                    bucket["session"] = True
            if bucket["session"]:
                try:
                    session = await self._store.get_session(session_id)
                    if runtime_state is not None:
                        session = session.model_copy(
                            update={"status": runtime_state.status}
                        )
                    effective_capabilities = None
                    if bucket["capability_changed"]:
                        (
                            session,
                            _runtime_capabilities,
                            effective_capabilities,
                        ) = await project_session_capabilities(
                            self._store,
                            self._presence,
                            session,
                        )
                    else:
                        session = await with_effective_session_connector_status(
                            self._presence,
                            session,
                        )
                    envelope["session"] = session.model_dump(mode="json")
                    if effective_capabilities is not None:
                        envelope["capabilitySet"] = effective_capabilities.model_dump(
                            mode="json"
                        )
                except KeyError:
                    pass
            if bucket["notices"]:
                envelope["notices"] = [
                    notice.model_dump(mode="json")
                    for notice in bucket["notices"]
                ]
            if bucket["catalogs"]:
                envelope["catalogs"] = bucket["catalogs"]
            if not any(
                key in envelope
                for key in (
                    "refetch",
                    "timelineReset",
                    "items",
                    "runtimeState",
                    "session",
                    "capabilitySet",
                    "notices",
                    "catalogs",
                )
            ):
                return status_changed
            await self._timeline_broker.publish(session_id, envelope)
            return status_changed

        for session_id, bucket in by_session.items():
            if bucket["deferred_timeline_only"]:
                dashboard_changed = (
                    await publish_bucket(session_id, bucket)
                    or dashboard_changed
                )
                continue
            async with self._store.session_revision_fence(session_id):
                dashboard_changed = (
                    await publish_bucket(session_id, bucket)
                    or dashboard_changed
                )
        return dashboard_changed

    async def _apply_runtime_status(self, connector_id: str, params: dict) -> None:
        runtime_id = params.get("runtimeId")
        status = params.get("status")
        if not isinstance(runtime_id, str) or not runtime_id:
            raise ValueError("runtime.statusChanged requires runtimeId")
        if not isinstance(status, str) or not status:
            raise ValueError("runtime.statusChanged requires status")
        error = params.get("error") if isinstance(params.get("error"), dict) else None
        try:
            await self._device_runtimes.apply_status(
                connector_id,
                runtime_id,
                status,
                error=error,
            )
        except DeviceRuntimeNotFoundError:
            # Runtime lifecycle notifications may arrive while the connector is
            # still producing the inventory snapshot for a fresh pairing or
            # reconnect. Inventory is the source that creates runtime rows; a
            # pre-inventory status must not tear down the connector WebSocket.
            return


def runtime_state_from_ingest_effect(
    session: SessionView,
    next_seq: int,
    raw_state: dict[str, Any],
) -> SessionRuntimeState:
    now = utc_now()
    session_id, runtime, runtime_id = resolve_session_runtime_binding(
        raw_state,
        session_id=session.id,
        runtime_type=session.runtime,
        runtime_id=session.runtimeId or session.runtime,
    )
    return SessionRuntimeState.model_validate(
        {
            "sessionId": session_id,
            "runtime": runtime,
            "runtimeId": runtime_id,
            "externalSessionId": raw_state.get("externalSessionId"),
            "status": raw_state.get("status") or "idle",
            "selections": raw_state.get("selections")
            if isinstance(raw_state.get("selections"), dict)
            else {},
            "statusReason": raw_state.get("statusReason"),
            "error": raw_state.get("error")
            if isinstance(raw_state.get("error"), dict)
            else None,
            "metadata": raw_state.get("metadata")
            if isinstance(raw_state.get("metadata"), dict)
            else {},
            "updatedSeq": next_seq,
            "createdAt": now,
            "updatedAt": now,
        }
    )


def runtime_states_semantically_equal(
    left: SessionRuntimeState | None,
    right: SessionRuntimeState,
) -> bool:
    if left is None:
        return False
    return runtime_state_fingerprint(left) == runtime_state_fingerprint(right)


def runtime_state_fingerprint(value: SessionRuntimeState) -> dict[str, Any]:
    return {
        "sessionId": value.sessionId,
        "runtime": value.runtime,
        "runtimeId": value.runtimeId,
        "externalSessionId": value.externalSessionId,
        "status": value.status,
        "selections": value.selections,
        "statusReason": value.statusReason,
        "error": value.error,
    }
