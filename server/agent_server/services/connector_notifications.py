from __future__ import annotations

from typing import Any, ClassVar

from loguru import logger
from pydantic import ValidationError

from agent_server.core.catalogs import (
    CatalogType,
    validate_model_catalog,
    validate_permission_catalog,
)
from agent_server.core.models import (
    NoticeIn,
    SessionStatus,
    SessionView,
    TimelineItemIn,
)
from agent_server.core.protocol import (
    ProtocolCapability,
    ProtocolCapabilitySet,
    ProtocolModelCatalog,
    ProtocolPermissionCatalog,
)
from agent_server.core.runtime_identity import RuntimeIdentity, RuntimeIdentityError
from agent_server.services.connector_realtime import ConnectorRealtimeService
from agent_server.services.ingest_effects import IngestEffect
from agent_server.services.repository_ports import ConnectorNotificationRepository

TIMELINE_SYNC_PUSH_LIMIT = 100
SESSION_INVENTORY_LIMIT = 10_000
SESSION_SOURCE_STATES = {
    "available",
    "archived",
    "unavailable",
    "deleted",
    "missing",
    "unknown",
    "visible",
    "hidden",
}
SESSION_SOURCE_ORIGINS = {"event", "inventory", "operation"}
TURN_END_OUTCOMES = {"completed", "interrupted", "cancelled", "failed"}


class NotificationValidationError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ConnectorNotificationService:
    def __init__(
        self,
        store: ConnectorNotificationRepository,
        realtime: ConnectorRealtimeService,
    ) -> None:
        self._realtime = realtime
        self._handlers = (
            ConnectorProtocolNotificationHandler(store),
            RuntimeCatalogNotificationHandler(store),
            SessionStateNotificationHandler(store),
            SessionTurnEndedNotificationHandler(store),
            SessionSourceNotificationHandler(store),
            SessionInventoryNotificationHandler(store),
            SessionNotificationHandler(store),
            TimelineNotificationHandler(store),
            InteractionNotificationHandler(store),
        )

    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> IngestEffect:
        if method != "session.turnEnded":
            params = _without_runtime_turn_ids(params)
        if method == "approval.requested":
            raise NotificationValidationError(
                "unsupported_notification",
                "approval.requested was replaced by notice.upsert interactions",
            )
        if method in {
            "protocol.modelCatalogUpdated",
            "protocol.permissionCatalogUpdated",
        }:
            raise NotificationValidationError(
                "unsupported_notification",
                "runtime catalogs are live Connector RPC reads and are no longer ingested",
            )
        if await self._realtime.apply(
            connector_id=connector_id,
            method=method,
            params=params,
        ):
            return IngestEffect()
        for handler in self._handlers:
            effect = await handler.apply(
                connector_id=connector_id,
                method=method,
                params=params,
            )
            if effect is not None:
                return effect
        return IngestEffect()


class ConnectorProtocolNotificationHandler:
    METHODS: ClassVar[set[str]] = {
        "connector.heartbeat",
        "connector.preferencesUpdated",
        "protocol.capabilitiesUpdated",
        "runtime.capability.updated",
    }

    def __init__(self, store: ConnectorNotificationRepository) -> None:
        self._store = store

    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> IngestEffect | None:
        if method not in self.METHODS:
            return None
        if method == "connector.heartbeat":
            await self._store.record_connector_activity(connector_id)
        elif method == "connector.preferencesUpdated":
            await self._update_preferences(connector_id, params)
        elif method == "protocol.capabilitiesUpdated":
            return await self._update_capabilities(connector_id, params)
        elif method == "runtime.capability.updated":
            return await self._merge_runtime_capability_update(connector_id, params)
        return IngestEffect()

    async def _update_preferences(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> None:
        try:
            await self._store.update_connector_preferences(connector_id, dict(params))
        except KeyError:
            logger.warning(
                "preferences update for unknown connector connector_id={}",
                connector_id,
            )

    async def _update_capabilities(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> IngestEffect:
        try:
            capability_set = ProtocolCapabilitySet.model_validate(params)
        except ValidationError as exc:
            raise NotificationValidationError(
                "invalid_protocol_capabilities",
                str(exc),
            ) from exc
        try:
            current = ProtocolCapabilitySet.model_validate(
                await self._store.get_protocol_capabilities(connector_id)
            )
            if capability_sets_semantically_equal(current, capability_set):
                return IngestEffect()
            await self._store.update_protocol_capabilities(
                connector_id,
                capability_set.model_dump(mode="json"),
            )
            return IngestEffect(protocol_changed=True)
        except KeyError:
            logger.warning(
                "protocol capabilities update for unknown connector connector_id={}",
                connector_id,
            )
            return IngestEffect()

    async def _merge_runtime_capability_update(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> IngestEffect:
        try:
            incoming = ProtocolCapabilitySet.model_validate(params)
        except ValidationError as exc:
            raise NotificationValidationError(
                "invalid_runtime_capabilities",
                str(exc),
            ) from exc
        try:
            current = ProtocolCapabilitySet.model_validate(
                await self._store.get_protocol_capabilities(connector_id)
            )
            merged = merge_capability_sets(current, incoming)
            if capability_sets_semantically_equal(current, merged):
                return IngestEffect()
            await self._store.update_protocol_capabilities(
                connector_id,
                merged.model_dump(mode="json"),
            )
        except KeyError:
            logger.warning(
                "runtime capability update for unknown connector connector_id={}",
                connector_id,
            )
            return IngestEffect()
        session_id = runtime_capability_update_session_id(incoming)
        return IngestEffect(
            session_id=session_id,
            session_changed=session_id is not None,
            protocol_changed=True,
        )


class RuntimeCatalogNotificationHandler:
    METHODS: ClassVar[set[str]] = {"runtime.catalog.updated"}

    def __init__(self, store: ConnectorNotificationRepository) -> None:
        self._store = store

    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> IngestEffect | None:
        if method not in self.METHODS:
            return None

        catalog_type = runtime_catalog_type_from_params(params)
        catalog = runtime_catalog_from_params(catalog_type, params)
        runtime, runtime_id = runtime_catalog_identity_from_params(params, catalog)
        if catalog.runtime != runtime:
            raise NotificationValidationError(
                "invalid_runtime_catalog",
                "runtime catalog provider does not match its instance scope",
            )
        outcome = await self._store.update_protocol_catalog(
            connector_id,
            runtime=catalog.runtime,
            runtime_id=runtime_id,
            catalog_type=catalog_type,
            revision=catalog.revision,
            catalog=catalog.model_dump(mode="json"),
        )
        if outcome in {"idempotent", "stale"}:
            return IngestEffect()
        if outcome == "conflict":
            raise NotificationValidationError(
                "catalog_revision_conflict",
                "catalog content changed without a revision increase",
            )

        sessions = await self._store.list_sessions_for_connector(connector_id)
        session_ids = session_ids_for_runtime_catalog(sessions, runtime_id)
        return IngestEffect(
            session_ids=session_ids,
            catalogs={catalog_type: catalog.model_dump(mode="json")},
        )


class SessionNotificationHandler:
    def __init__(self, store: ConnectorNotificationRepository) -> None:
        self._store = store

    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> IngestEffect | None:
        if method not in {"session.meta.upsert", "session.updated"}:
            return None
        if method == "session.updated":
            _reject_legacy_selection_fields(params, notification=method)
        session_id = params["sessionId"]
        external_session_id = params.get("externalSessionId")
        runtime, runtime_id = runtime_identity_from_params(params)
        source_observation = _session_meta_source_observation(params, runtime)
        try:
            if isinstance(external_session_id, str):
                session_id = await self._store.resolve_connector_session_id(
                    connector_id=connector_id,
                    session_id=session_id,
                    external_session_id=external_session_id,
                    runtime=runtime,
                    runtime_id=runtime_id,
                )
            existing_session = await self._store.get_session(session_id)
            _require_session_binding(
                existing_session,
                connector_id=connector_id,
                runtime=runtime,
                runtime_id=runtime_id,
            )
            session = await self._store.update_session_snapshot(
                session_id=session_id,
                title=params.get("title"),
                cwd=params.get("cwd"),
                external_session_id=external_session_id,
                last_synced_at=params.get("lastSyncedAt"),
                source_observed_at=params.get("sourceObservedAt"),
                last_activity_at=params.get("lastActivityAt"),
                mark_read_on_change=True,
                source_state=None,
            )
            if source_observation is not None:
                session = await self._store.update_session_source_state(
                    session.id,
                    **source_observation,
                )
            return IngestEffect(session_id=session.id, session_changed=True)
        except KeyError:
            try:
                session = await self._store.upsert_connector_session(
                    connector_id=connector_id,
                    session_id=session_id,
                    runtime=runtime,
                    runtime_id=runtime_id,
                    external_session_id=_string_or_none(external_session_id),
                    title=params.get("title"),
                    cwd=params.get("cwd"),
                    last_synced_at=params.get("lastSyncedAt"),
                    source_observed_at=params.get("sourceObservedAt"),
                    last_activity_at=params.get("lastActivityAt"),
                    source_state=None,
                )
            except ValueError as exc:
                raise NotificationValidationError(
                    "session_identity_conflict",
                    str(exc),
                ) from exc
            if source_observation is not None:
                session = await self._store.update_session_source_state(
                    session.id,
                    **source_observation,
                )
            return IngestEffect(session_id=session.id, session_changed=True)


class SessionSourceNotificationHandler:
    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> IngestEffect | None:
        if method != "session.source.updated":
            return None
        runtime, runtime_id = runtime_identity_from_params(params)
        session_id = params.get("sessionId")
        external_session_id = _string_or_none(params.get("externalSessionId"))
        if not isinstance(session_id, str) or not session_id:
            raise NotificationValidationError(
                "invalid_session_source_session",
                "session source observation sessionId must be a non-empty string",
            )
        observation = _validated_session_source_observation(params)
        if external_session_id is not None:
            try:
                session_id = await self._store.resolve_connector_session_id(
                    connector_id=connector_id,
                    session_id=session_id,
                    external_session_id=external_session_id,
                    runtime=runtime,
                    runtime_id=runtime_id,
                )
            except KeyError:
                pass
        try:
            session = await self._store.get_session(session_id)
            _require_session_binding(
                session,
                connector_id=connector_id,
                runtime=runtime,
                runtime_id=runtime_id,
            )
        except KeyError:
            session = await self._store.upsert_connector_session(
                connector_id=connector_id,
                session_id=session_id,
                runtime=runtime,
                runtime_id=runtime_id,
                external_session_id=external_session_id,
            )
        session = await self._store.update_session_source_state(
            session.id,
            **observation,
        )
        return IngestEffect(session_id=session.id, session_changed=True)

    def __init__(self, store: ConnectorNotificationRepository) -> None:
        self._store = store


class SessionInventoryNotificationHandler:
    METHODS: ClassVar[set[str]] = {
        "session.inventory.begin",
        "session.inventory.complete",
    }

    def __init__(self, store: ConnectorNotificationRepository) -> None:
        self._store = store

    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> IngestEffect | None:
        if method not in self.METHODS:
            return None
        runtime, runtime_id = runtime_identity_from_params(params)
        scan_token = params.get("scanToken")
        if not isinstance(scan_token, str) or not 16 <= len(scan_token) <= 128:
            raise NotificationValidationError(
                "invalid_session_inventory_token",
                "session inventory scanToken must contain 16 to 128 characters",
            )
        if method == "session.inventory.begin":
            await self._store.begin_session_inventory(
                connector_id,
                runtime,
                runtime_id,
                scan_token,
            )
            return IngestEffect()

        raw_sessions = params.get("sessions")
        complete = params.get("complete")
        if not isinstance(raw_sessions, list) or len(raw_sessions) > SESSION_INVENTORY_LIMIT:
            raise NotificationValidationError(
                "invalid_session_inventory_sessions",
                f"session inventory sessions must contain at most {SESSION_INVENTORY_LIMIT} entries",
            )
        if not isinstance(complete, bool):
            raise NotificationValidationError(
                "invalid_session_inventory_complete",
                "session inventory complete must be a boolean",
            )
        entries: list[dict[str, str | None]] = []
        session_ids: set[str] = set()
        external_session_ids: set[str] = set()
        for raw in raw_sessions:
            if not isinstance(raw, dict):
                raise NotificationValidationError(
                    "invalid_session_inventory_entry",
                    "session inventory entries must be objects",
                )
            session_id = raw.get("sessionId")
            external_session_id = raw.get("externalSessionId")
            raw_source_state = raw.get("sourceState")
            source_state = (
                raw_source_state.get("availability")
                if isinstance(raw_source_state, dict)
                else raw_source_state
            )
            if not isinstance(session_id, str) or not session_id:
                raise NotificationValidationError(
                    "invalid_session_inventory_entry",
                    "session inventory entry sessionId must be a non-empty string",
                )
            if external_session_id is not None and (
                not isinstance(external_session_id, str) or not external_session_id
            ):
                raise NotificationValidationError(
                    "invalid_session_inventory_entry",
                    "session inventory entry externalSessionId must be a non-empty string",
                )
            if source_state not in SESSION_SOURCE_STATES:
                raise NotificationValidationError(
                    "invalid_session_inventory_entry",
                    "session inventory entry sourceState is invalid",
                )
            if session_id in session_ids or (
                external_session_id is not None
                and external_session_id in external_session_ids
            ):
                raise NotificationValidationError(
                    "duplicate_session_inventory_entry",
                    "session inventory entries must have unique session identifiers",
                )
            session_ids.add(session_id)
            if external_session_id is not None:
                external_session_ids.add(external_session_id)
            entries.append(
                {
                    "session_id": session_id,
                    "external_session_id": external_session_id,
                    "source_state": source_state,
                    "reason": (
                        raw_source_state.get("reason")
                        if isinstance(raw_source_state, dict)
                        else None
                    ),
                    "observed_at": (
                        raw_source_state.get("observedAt")
                        if isinstance(raw_source_state, dict)
                        else None
                    ),
                }
            )
        changed = await self._store.complete_session_inventory(
            connector_id,
            runtime,
            runtime_id,
            scan_token,
            entries,
            complete=complete,
        )
        return IngestEffect(session_ids=changed)


class SessionStateNotificationHandler:
    def __init__(self, store: ConnectorNotificationRepository) -> None:
        self._store = store

    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> IngestEffect | None:
        if method != "session.state.updated":
            return None
        _reject_legacy_selection_fields(params, notification=method)
        session_id = params["sessionId"]
        runtime, runtime_id = runtime_identity_from_params(params)
        external_session_id = _string_or_none(params.get("externalSessionId"))
        if external_session_id is not None:
            try:
                session_id = await self._store.resolve_connector_session_id(
                    connector_id=connector_id,
                    session_id=session_id,
                    external_session_id=external_session_id,
                    runtime=runtime,
                    runtime_id=runtime_id,
                )
            except KeyError:
                pass
        try:
            session = await self._store.get_session(session_id)
        except KeyError:
            try:
                session = await self._store.upsert_connector_session(
                    connector_id=connector_id,
                    session_id=session_id,
                    runtime=runtime,
                    runtime_id=runtime_id,
                    external_session_id=external_session_id,
                )
            except ValueError as exc:
                raise NotificationValidationError(
                    "session_identity_conflict",
                    str(exc),
                ) from exc
            session_id = session.id
        else:
            _require_session_binding(
                session,
                connector_id=connector_id,
                runtime=runtime,
                runtime_id=runtime_id,
            )
        runtime_state = runtime_state_from_session_state_params(
            session_id=session_id,
            runtime=runtime,
            runtime_id=runtime_id,
            external_session_id=external_session_id,
            params=params,
        )
        if (
            runtime_state["status"] == "running"
            and await self._store.get_active_run(session_id) is None
        ):
            await self._store.start_active_run(
                session_id=session_id,
                runtime=runtime,
                runtime_id=runtime_id,
                external_session_id=external_session_id,
            )
        if runtime_state["status"] in {"idle", "error"}:
            await self._store.clear_active_run(session_id)
        return IngestEffect(
            session_id=session_id,
            runtime_state=runtime_state,
        )


class SessionTurnEndedNotificationHandler:
    def __init__(self, store: ConnectorNotificationRepository) -> None:
        self._store = store

    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> IngestEffect | None:
        if method != "session.turnEnded":
            return None
        session_id = params.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise NotificationValidationError(
                "invalid_session_id",
                "session.turnEnded sessionId must be a non-empty string",
            )
        outcome = params.get("outcome")
        if outcome not in TURN_END_OUTCOMES:
            raise NotificationValidationError(
                "invalid_turn_outcome",
                "session.turnEnded outcome must be completed, interrupted, cancelled, or failed",
            )
        turn_id = params.get("turnId")
        if turn_id is not None and (not isinstance(turn_id, str) or not turn_id):
            raise NotificationValidationError(
                "invalid_turn_id",
                "session.turnEnded turnId must be a non-empty string when provided",
            )
        runtime, runtime_id = runtime_identity_from_params(params)
        external_session_id = _string_or_none(params.get("externalSessionId"))
        if external_session_id is not None:
            try:
                session_id = await self._store.resolve_connector_session_id(
                    connector_id=connector_id,
                    session_id=session_id,
                    external_session_id=external_session_id,
                    runtime=runtime,
                    runtime_id=runtime_id,
                )
            except KeyError:
                pass
        try:
            session = await self._store.get_session(session_id)
        except KeyError:
            try:
                session = await self._store.upsert_connector_session(
                    connector_id=connector_id,
                    session_id=session_id,
                    runtime=runtime,
                    runtime_id=runtime_id,
                    external_session_id=external_session_id,
                )
            except ValueError as exc:
                raise NotificationValidationError(
                    "session_identity_conflict",
                    str(exc),
                ) from exc
            session_id = session.id
        else:
            _require_session_binding(
                session,
                connector_id=connector_id,
                runtime=runtime,
                runtime_id=runtime_id,
            )
        if await _session_disabled(self._store, session_id):
            return IngestEffect()
        session = await self._store.record_session_turn_end(
            session_id=session_id,
            source_observed_at=_string_or_none(params.get("sourceObservedAt")),
            mark_read_on_change=False,
        )
        return IngestEffect(session_id=session.id, session_changed=True)


class TimelineNotificationHandler:
    METHODS: ClassVar[set[str]] = {"timeline.sync", "timeline.itemUpsert"}

    def __init__(self, store: ConnectorNotificationRepository) -> None:
        self._store = store

    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> IngestEffect | None:
        if method not in self.METHODS:
            return None
        if method == "timeline.sync":
            return await self._sync(connector_id, params)
        return await self._upsert(connector_id, params)

    async def _sync(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> IngestEffect:
        items = [TimelineItemIn.model_validate(item) for item in params.get("items", [])]
        runtime, runtime_id = await timeline_runtime_identity_from_params(
            self._store,
            params,
        )
        requested_session_id = params["sessionId"]
        session_id = await _resolve_timeline_session_id(
            self._store,
            connector_id,
            requested_session_id,
            items,
            runtime=runtime,
            runtime_id=runtime_id,
        )
        if await _session_disabled(self._store, session_id):
            return IngestEffect()
        items = [_timeline_item_for_session(item, session_id) for item in items]
        replace_snapshot = params.get("complete") is True
        if replace_snapshot:
            result = await self._store.replace_timeline_snapshot(
                session_id=session_id,
                source_observed_at=params.get("sourceObservedAt"),
                items=items,
                mark_read_on_change=True,
            )
        else:
            result = await self._store.sync_timeline_items(
                session_id=session_id,
                source_observed_at=params.get("sourceObservedAt"),
                items=items,
                mark_read_on_change=True,
            )
        changed_items = list(result.items) if result.changed else []
        push_items = len(changed_items) <= TIMELINE_SYNC_PUSH_LIMIT
        return IngestEffect(
            session_id=session_id,
            items=[item.model_dump(mode="json") for item in changed_items]
            if push_items
            else None,
            timeline_reset=replace_snapshot and result.changed and push_items,
            needs_refetch=not push_items,
        )

    async def _upsert(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> IngestEffect:
        if _timeline_item_type(params.get("item")) in {"turn.start", "turn.end"}:
            raise NotificationValidationError(
                "unsupported_timeline_marker",
                "turn lifecycle markers must use dedicated session notifications",
            )
        item = TimelineItemIn.model_validate(params["item"])
        runtime, runtime_id = await timeline_runtime_identity_from_params(
            self._store,
            params,
        )
        session_id = await _resolve_timeline_session_id(
            self._store,
            connector_id,
            params["sessionId"],
            [item],
            runtime=runtime,
            runtime_id=runtime_id,
        )
        if await _session_disabled(self._store, session_id):
            return IngestEffect()
        item = _timeline_item_for_session(item, session_id)
        result = await self._store.upsert_timeline_item(
            session_id=session_id,
            source_observed_at=params.get("sourceObservedAt"),
            item=item,
            mark_read_on_change=True,
        )
        return IngestEffect(
            session_id=session_id,
            item=result.item.model_dump(mode="json") if result.changed else None,
        )


class InteractionNotificationHandler:
    METHODS: ClassVar[set[str]] = {
        "notice.upsert",
        "runtime.error",
    }

    def __init__(self, store: ConnectorNotificationRepository) -> None:
        self._store = store

    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> IngestEffect | None:
        if method not in self.METHODS:
            return None
        if method == "notice.upsert":
            return await self._notice(connector_id, params)
        return await self._runtime_error(connector_id, params)

    async def _notice(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> IngestEffect:
        try:
            notice = NoticeIn.model_validate(params)
        except ValidationError as exc:
            raise NotificationValidationError("invalid_notice", str(exc)) from exc
        runtime, runtime_id = await interaction_runtime_identity_from_params(
            self._store,
            params,
        )
        if not await _session_matches_runtime(
            self._store,
            notice.sessionId,
            runtime,
            runtime_id,
            connector_id=connector_id,
        ):
            return IngestEffect()
        return IngestEffect(
            session_id=notice.sessionId,
            notices=[notice],
            session_changed=notice.type == "interaction" or notice.blocking is not None,
            notices_changed=True,
        )

    async def _runtime_error(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> IngestEffect:
        session_id = params.get("sessionId")
        runtime, runtime_id = await interaction_runtime_identity_from_params(
            self._store,
            params,
        )
        if not isinstance(session_id, str) or not await _session_matches_runtime(
            self._store,
            session_id,
            runtime,
            runtime_id,
            connector_id=connector_id,
        ):
            return IngestEffect()
        notice = NoticeIn.model_validate(
            {
                "noticeId": params.get("noticeId") or f"runtime_error_{session_id}",
                "type": "notification",
                "sessionId": session_id,
                "source": {
                    "runtime": _string_or_none(params.get("runtime")),
                    "component": "runtime",
                    "operationId": _string_or_none(params.get("operationId")),
                },
                "title": params.get("title") or "Runtime error",
                "message": _string_or_none(params.get("message")),
                "severity": "error",
                "status": params.get("status") or "open",
                "context": {
                    "error": {
                        "code": "runtime_error",
                        "message": params.get("message")
                        or "The runtime reported an error.",
                        "details": params,
                    },
                    "reason": "runtime_error",
                },
            }
        )
        return IngestEffect(
            session_id=session_id,
            notices=[notice],
            session_changed=True,
            notices_changed=True,
        )


def merge_capability_sets(
    current: ProtocolCapabilitySet,
    incoming: ProtocolCapabilitySet,
) -> ProtocolCapabilitySet:
    capabilities_by_key = {
        capability_identity_key(capability): capability
        for capability in current.capabilities
    }
    for capability in incoming.capabilities:
        capabilities_by_key[capability_identity_key(capability)] = capability
    return ProtocolCapabilitySet(
        revision=max(current.revision, incoming.revision),
        capabilities=list(capabilities_by_key.values()),
    )


def capability_sets_semantically_equal(
    left: ProtocolCapabilitySet,
    right: ProtocolCapabilitySet,
) -> bool:
    return capability_set_fingerprint(left) == capability_set_fingerprint(right)


def capability_set_fingerprint(value: ProtocolCapabilitySet) -> list[dict[str, Any]]:
    return sorted(
        (capability.model_dump(mode="json") for capability in value.capabilities),
        key=lambda item: (
            str(item.get("capabilityId") or ""),
            str(item.get("runtime") or ""),
            str(item.get("runtimeId") or ""),
            str(item.get("scope") or ""),
            str(item.get("sessionId") or ""),
        ),
    )


def runtime_catalog_type_from_params(params: dict[str, Any]) -> CatalogType:
    catalog_type = params.get("catalogType")
    if catalog_type == "model" or catalog_type == "permission":
        return catalog_type
    raise NotificationValidationError(
        "invalid_runtime_catalog",
        "runtime.catalog.updated requires catalogType model or permission",
    )


def runtime_catalog_from_params(
    catalog_type: CatalogType,
    params: dict[str, Any],
) -> ProtocolModelCatalog | ProtocolPermissionCatalog:
    raw_catalog = params.get("catalog")
    if not isinstance(raw_catalog, dict):
        raise NotificationValidationError(
            "invalid_runtime_catalog",
            "runtime.catalog.updated requires catalog",
        )
    try:
        if catalog_type == "model":
            model_catalog = ProtocolModelCatalog.model_validate(raw_catalog)
            validate_model_catalog(model_catalog)
            return model_catalog
        permission_catalog = ProtocolPermissionCatalog.model_validate(raw_catalog)
        validate_permission_catalog(permission_catalog)
        return permission_catalog
    except ValidationError as exc:
        raise NotificationValidationError("invalid_runtime_catalog", str(exc)) from exc
    except ValueError as exc:
        raise NotificationValidationError("invalid_runtime_catalog", str(exc)) from exc


def session_ids_for_runtime_catalog(
    sessions: list[SessionView],
    runtime_id: str,
) -> list[str]:
    return [session.id for session in sessions if session.runtimeId == runtime_id]


def capability_identity_key(
    capability: ProtocolCapability,
) -> tuple[str, str, str | None, str | None, str | None]:
    return (
        capability.capabilityId,
        capability.scope,
        capability.runtime,
        _string_or_none(getattr(capability, "runtimeId", None)),
        capability.sessionId,
    )


def runtime_capability_update_session_id(
    capability_set: ProtocolCapabilitySet,
) -> str | None:
    session_ids = {
        capability.sessionId
        for capability in capability_set.capabilities
        if capability.scope == "session" and capability.sessionId is not None
    }
    if len(session_ids) == 1:
        return next(iter(session_ids))
    return None


async def _session_disabled(store: ConnectorNotificationRepository, session_id: str) -> bool:
    return await store.get_session_runtime(session_id) is None


async def _session_matches_runtime(
    store: ConnectorNotificationRepository,
    session_id: str,
    runtime: str,
    runtime_id: str,
    *,
    connector_id: str,
) -> bool:
    try:
        session = await store.get_session(session_id)
    except KeyError:
        return False
    _require_session_binding(
        session,
        connector_id=connector_id,
        runtime=runtime,
        runtime_id=runtime_id,
    )
    return True


def _require_session_binding(
    session: SessionView,
    *,
    connector_id: str,
    runtime: str,
    runtime_id: str,
) -> None:
    if session.connectorId != connector_id:
        raise NotificationValidationError(
            "session_connector_mismatch",
            "notification connector does not match the session binding",
        )
    if session.runtime != runtime or session.runtimeId != runtime_id:
        raise NotificationValidationError(
            "session_runtime_mismatch",
            "notification runtime does not match the session binding",
        )


async def _resolve_timeline_session_id(
    store: ConnectorNotificationRepository,
    connector_id: str,
    session_id: str,
    items: list[TimelineItemIn],
    *,
    runtime: str,
    runtime_id: str,
) -> str:
    external_session_id = next(
        (item.source.sessionId for item in items if item.source.sessionId),
        None,
    )
    return await _resolve_timeline_session_id_by_external(
        store,
        connector_id,
        session_id,
        external_session_id,
        runtime=runtime,
        runtime_id=runtime_id,
    )


async def _resolve_timeline_session_id_by_external(
    store: ConnectorNotificationRepository,
    connector_id: str,
    session_id: str,
    external_session_id: str | None,
    *,
    runtime: str,
    runtime_id: str,
) -> str:
    try:
        return await store.resolve_connector_session_id(
            connector_id=connector_id,
            session_id=session_id,
            external_session_id=external_session_id,
            runtime=runtime,
            runtime_id=runtime_id,
        )
    except KeyError:
        try:
            session = await store.get_session(session_id)
        except KeyError:
            return session_id
        _require_session_binding(
            session,
            connector_id=connector_id,
            runtime=runtime,
            runtime_id=runtime_id,
        )
        return session_id


def _timeline_item_type(value: Any) -> str | None:
    return value.get("type") if isinstance(value, dict) else None


def _v2_session_status(value: Any) -> SessionStatus | None:
    if value is None:
        return None
    if value in {
        "idle",
        "waiting",
        "pending",
        "running",
        "stopping",
        "waiting_approval",
        "error",
        "blocked",
    }:
        return str(value)
    return "idle"


def _session_meta_should_archive(params: dict[str, Any]) -> bool:
    metadata = params.get("metadata") if isinstance(params.get("metadata"), dict) else {}
    if _bool_param(params, metadata, ("hidden",)):
        return True
    if _bool_param(params, metadata, ("localArchived", "local_archived")):
        return True
    if _bool_param(params, metadata, ("localDeleted", "local_deleted")):
        return True
    if params.get("resumeSupported") is False or params.get("resumable") is False:
        return True
    local_state = _string_param(
        params,
        metadata,
        ("localState", "local_state"),
    )
    return local_state in {"archived", "deleted", "unresumable"}


def _validated_session_source_observation(params: dict[str, Any]) -> dict[str, Any]:
    availability = params.get("availability")
    if availability not in SESSION_SOURCE_STATES:
        raise NotificationValidationError(
            "invalid_session_source_availability",
            "session source observation availability is invalid",
        )
    observation_origin = params.get("observationOrigin")
    if observation_origin not in SESSION_SOURCE_ORIGINS:
        raise NotificationValidationError(
            "invalid_session_source_origin",
            "session source observation origin is invalid",
        )
    reason = params.get("reason")
    observed_at = params.get("observedAt")
    if reason is not None and not isinstance(reason, str):
        raise NotificationValidationError(
            "invalid_session_source_reason",
            "session source observation reason must be a string",
        )
    if observed_at is not None and not isinstance(observed_at, str):
        raise NotificationValidationError(
            "invalid_session_source_observed_at",
            "session source observation observedAt must be a string",
        )
    return {
        "availability": availability,
        "reason": reason,
        "observed_at": observed_at,
        "observation_origin": observation_origin,
    }


def _session_meta_source_observation(
    params: dict[str, Any],
    runtime: str,
) -> dict[str, Any] | None:
    source_state = params.get("sourceState")
    if isinstance(source_state, dict):
        return _validated_session_source_observation(
            {
                "availability": source_state.get("availability"),
                "reason": source_state.get("reason"),
                "observedAt": source_state.get("observedAt"),
                "observationOrigin": source_state.get(
                    "observationOrigin",
                    "inventory",
                ),
            }
        )
    if runtime == "dsh":
        return {
            "availability": _dsh_session_meta_source_state(params),
            "reason": None,
            "observed_at": params.get("sourceObservedAt"),
            "observation_origin": "inventory",
        }
    if not _session_meta_should_archive(params):
        return None
    metadata = params.get("metadata") if isinstance(params.get("metadata"), dict) else {}
    deleted = _bool_param(params, metadata, ("localDeleted", "local_deleted"))
    local_state = _string_param(params, metadata, ("localState", "local_state"))
    return {
        "availability": "deleted" if deleted or local_state == "deleted" else "archived",
        "reason": "legacy session metadata",
        "observed_at": params.get("sourceObservedAt"),
        "observation_origin": "inventory",
    }


def _dsh_session_meta_source_state(params: dict[str, Any]) -> str:
    metadata = params.get("metadata") if isinstance(params.get("metadata"), dict) else {}
    if _bool_param(params, metadata, ("localDeleted", "local_deleted")):
        return "missing"
    local_state = _string_param(
        params,
        metadata,
        ("localState", "local_state"),
    )
    if local_state == "deleted":
        return "missing"
    if _bool_param(params, metadata, ("hidden",)):
        return "hidden"
    if _bool_param(params, metadata, ("localArchived", "local_archived")):
        return "hidden"
    if params.get("resumeSupported") is False or params.get("resumable") is False:
        return "hidden"
    return "hidden" if local_state in {"archived", "unresumable"} else "visible"


def _bool_param(
    params: dict[str, Any],
    metadata: dict[str, Any],
    keys: tuple[str, ...],
) -> bool:
    for key in keys:
        if params.get(key) is True or metadata.get(key) is True:
            return True
    return False


def _string_param(
    params: dict[str, Any],
    metadata: dict[str, Any],
    keys: tuple[str, ...],
) -> str | None:
    for key in keys:
        value = params.get(key)
        if isinstance(value, str) and value:
            return value.lower()
        metadata_value = metadata.get(key)
        if isinstance(metadata_value, str) and metadata_value:
            return metadata_value.lower()
    return None


def _string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def runtime_identity_from_params(params: dict[str, Any]) -> tuple[str, str]:
    runtime = params.get("runtime") or "codex"
    runtime_id = params.get("runtimeId") or runtime
    try:
        identity = RuntimeIdentity.create(
            runtime_type=runtime,
            runtime_id=runtime_id,
        )
    except RuntimeIdentityError as exc:
        raise NotificationValidationError(
            "invalid_runtime_identity",
            str(exc),
        ) from exc
    return str(identity.runtime_type), str(identity.runtime_id)


def runtime_catalog_identity_from_params(
    params: dict[str, Any],
    catalog: ProtocolModelCatalog | ProtocolPermissionCatalog,
) -> tuple[str, str]:
    if "runtime" not in params and "runtimeId" not in params:
        return runtime_identity_from_params(
            {
                "runtime": catalog.runtime,
                "runtimeId": catalog.runtime,
            }
        )
    return runtime_identity_from_params(params)


async def interaction_runtime_identity_from_params(
    store: ConnectorNotificationRepository,
    params: dict[str, Any],
) -> tuple[str, str]:
    if "runtime" in params or "runtimeId" in params:
        return runtime_identity_from_params(params)

    source = params.get("source")
    if isinstance(source, dict):
        runtime = source.get("runtimeType") or source.get("runtime")
        if isinstance(runtime, str) and runtime != "platform":
            return runtime_identity_from_params(
                {
                    "runtime": runtime,
                    "runtimeId": source.get("runtimeId") or runtime,
                }
            )

    session_id = params.get("sessionId")
    if isinstance(session_id, str):
        try:
            session = await store.get_session(session_id)
        except KeyError:
            pass
        else:
            return session.runtime, session.runtimeId or session.runtime

    return runtime_identity_from_params(params)


async def timeline_runtime_identity_from_params(
    store: ConnectorNotificationRepository,
    params: dict[str, Any],
) -> tuple[str, str]:
    if "runtime" in params or "runtimeId" in params:
        return runtime_identity_from_params(params)

    session_id = params.get("sessionId")
    if isinstance(session_id, str):
        try:
            session = await store.get_session(session_id)
        except KeyError:
            pass
        else:
            return session.runtime, session.runtimeId or session.runtime

    raw_items = params.get("items")
    raw_item = params.get("item")
    if isinstance(raw_item, dict):
        candidates = [raw_item]
    elif isinstance(raw_items, list):
        candidates = [item for item in raw_items if isinstance(item, dict)]
    else:
        candidates = []
    for candidate in candidates:
        source = candidate.get("source")
        if not isinstance(source, dict):
            continue
        runtime = source.get("runtimeType") or source.get("runtime")
        if isinstance(runtime, str) and runtime != "platform":
            return runtime_identity_from_params(
                {
                    "runtime": runtime,
                    "runtimeId": source.get("runtimeId") or runtime,
                }
            )
    return runtime_identity_from_params(params)


def _object_or_none(value: Any) -> dict[str, Any] | None:
    return dict(value) if isinstance(value, dict) else None


def _selections_param(params: dict[str, Any]) -> dict[str, str | None] | None:
    raw = params.get("selections")
    if not isinstance(raw, dict):
        return None
    selections: dict[str, str | None] = {}
    for scope, selection_id in raw.items():
        if not isinstance(scope, str) or not scope:
            continue
        if selection_id is not None and not isinstance(selection_id, str):
            continue
        selections[scope] = selection_id
    return selections


def _reject_legacy_selection_fields(params: dict[str, Any], *, notification: str) -> None:
    if "modelSelectionId" not in params and "permissionSelectionId" not in params:
        return
    raise NotificationValidationError(
        "unsupported_legacy_selection_fields",
        f"{notification} accepts selections; modelSelectionId and permissionSelectionId are not supported",
    )


def _has_runtime_state_fields(params: dict[str, Any]) -> bool:
    return any(
        key in params
        for key in (
            "status",
            "selections",
        )
    )


def runtime_state_from_session_state_params(
    session_id: str,
    runtime: str,
    runtime_id: str,
    external_session_id: str | None,
    params: dict[str, Any],
) -> dict[str, Any]:
    return {
        "sessionId": session_id,
        "runtime": runtime,
        "runtimeId": runtime_id,
        "externalSessionId": external_session_id,
        "status": _v2_session_status(params.get("status")) or "idle",
        "selections": _selections_param(params) or {},
        "statusReason": _string_or_none(params.get("statusReason")),
        "error": _object_or_none(params.get("error")),
        "metadata": _object_or_none(params.get("metadata")) or {},
    }


def _timeline_item_for_session(
    item: TimelineItemIn,
    session_id: str,
) -> TimelineItemIn:
    if item.sessionId == session_id:
        return item
    return TimelineItemIn.model_validate({**item.model_dump(), "sessionId": session_id})


def _without_runtime_turn_ids(value: Any) -> Any:
    """Keep legacy Connector turn identifiers outside Server business handlers."""

    if isinstance(value, dict):
        return {
            key: _without_runtime_turn_ids(item)
            for key, item in value.items()
            if key not in {"turnId", "turn_id"}
        }
    if isinstance(value, list):
        return [_without_runtime_turn_ids(item) for item in value]
    return value
