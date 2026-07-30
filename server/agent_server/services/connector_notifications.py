from __future__ import annotations

from typing import Any, ClassVar

from loguru import logger
from pydantic import ValidationError

from agent_server.core.catalogs import CatalogType
from agent_server.core.interactions import InteractionDomainError
from agent_server.core.models import ApprovalIn, NoticeIn, SessionStatus, TimelineItemIn
from agent_server.core.protocol import (
    ProtocolCapabilitySet,
)
from agent_server.services.catalogs import CatalogService, CatalogServiceError
from agent_server.services.connector_realtime import ConnectorRealtimeService
from agent_server.services.ingest_effects import IngestEffect
from agent_server.services.interactions import InteractionProjectionService
from agent_server.services.notices import (
    cancel_turn_blocking_interactions,
    upsert_execution_error_interaction,
)
from agent_server.services.repository_ports import ConnectorNotificationRepository
from agent_server.services.session_states import SessionStateService
from agent_server.services.timeline_effects import (
    close_waiting_approval_items_for_finished_turn,
)

TIMELINE_SYNC_PUSH_LIMIT = 100


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
            SessionNotificationHandler(store),
            TimelineNotificationHandler(store),
            InteractionNotificationHandler(
                store,
                InteractionProjectionService(store),
            ),
        )

    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> IngestEffect:
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
        "protocol.modelCatalogUpdated",
        "protocol.permissionCatalogUpdated",
    }

    def __init__(self, store: ConnectorNotificationRepository) -> None:
        self._store = store
        self._catalogs = CatalogService(store)

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
            await self._update_capabilities(connector_id, params)
        elif method == "protocol.modelCatalogUpdated":
            await self._update_catalog(connector_id, params, catalog_type="model")
        elif method == "protocol.permissionCatalogUpdated":
            await self._update_catalog(connector_id, params, catalog_type="permission")
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
    ) -> None:
        try:
            capability_set = ProtocolCapabilitySet.model_validate(params)
        except ValidationError as exc:
            raise NotificationValidationError(
                "invalid_protocol_capabilities",
                str(exc),
            ) from exc
        try:
            await self._store.update_protocol_capabilities(
                connector_id,
                capability_set.model_dump(mode="json"),
            )
        except KeyError:
            logger.warning(
                "protocol capabilities update for unknown connector connector_id={}",
                connector_id,
            )

    async def _update_catalog(
        self,
        connector_id: str,
        params: dict[str, Any],
        *,
        catalog_type: CatalogType,
    ) -> None:
        try:
            await self._catalogs.ingest(
                connector_id,
                catalog_type=catalog_type,
                payload=params,
            )
        except CatalogServiceError as exc:
            code = f"invalid_protocol_{catalog_type}_catalog" if exc.code == "invalid_catalog" else exc.code
            raise NotificationValidationError(
                code,
                exc.detail,
            ) from exc
        except KeyError:
            logger.warning(
                "{} catalog update for unknown connector connector_id={}",
                catalog_type,
                connector_id,
            )


class SessionNotificationHandler:
    def __init__(self, store: ConnectorNotificationRepository) -> None:
        self._store = store
        self._session_states = SessionStateService(store)

    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> IngestEffect | None:
        if method != "session.updated":
            return None
        local_state = _local_session_state(params)
        observed_status = _v2_session_status(params.get("status"))
        session_id = params["sessionId"]
        external_session_id = params.get("externalSessionId")
        try:
            if isinstance(external_session_id, str):
                session_id = await self._store.resolve_connector_session_id(
                    connector_id=connector_id,
                    session_id=session_id,
                    external_session_id=external_session_id,
                )
            await self._store.update_session_snapshot(
                session_id=session_id,
                title=params.get("title"),
                cwd=params.get("cwd"),
                external_session_id=external_session_id,
                last_synced_at=params.get("lastSyncedAt"),
                source_observed_at=params.get("sourceObservedAt"),
                last_activity_at=params.get("lastActivityAt"),
                model_selection_id=_string_or_none(params.get("modelSelectionId")),
                permission_selection_id=_string_or_none(params.get("permissionSelectionId")),
            )
            await self._session_states.reconcile(
                session_id,
                observed_status=observed_status,
                settle_stopping=observed_status not in {None, "stopping"},
            )
            return IngestEffect(session_id=session_id, session_changed=True)
        except KeyError:
            if local_state in {"archived", "deleted", "unresumable"}:
                logger.info(
                    "ignored local {} session discovery connector_id={} session_id={} external_session_id={}",
                    local_state,
                    connector_id,
                    session_id,
                    external_session_id,
                )
                return IngestEffect()
            session = await self._store.upsert_connector_session(
                connector_id=connector_id,
                session_id=session_id,
                runtime=params.get("runtime") or "codex",
                external_session_id=_string_or_none(external_session_id),
                title=params.get("title"),
                cwd=params.get("cwd"),
                last_synced_at=params.get("lastSyncedAt"),
                source_observed_at=params.get("sourceObservedAt"),
                last_activity_at=params.get("lastActivityAt"),
                model_selection_id=_string_or_none(params.get("modelSelectionId")),
                permission_selection_id=_string_or_none(params.get("permissionSelectionId")),
            )
            await self._session_states.reconcile(
                session.id,
                observed_status=observed_status,
                settle_stopping=observed_status not in {None, "stopping"},
            )
            return IngestEffect(session_id=session.id, session_changed=True)


class TimelineNotificationHandler:
    METHODS: ClassVar[set[str]] = {"timeline.sync", "timeline.itemUpsert"}

    def __init__(self, store: ConnectorNotificationRepository) -> None:
        self._store = store
        self._session_states = SessionStateService(store)

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
        session_id = await _resolve_timeline_session_id(
            self._store,
            connector_id,
            params["sessionId"],
            items,
        )
        if await _session_disabled(self._store, session_id):
            return IngestEffect()
        items = [_timeline_item_for_session(item, session_id) for item in items]
        items = await _tag_active_run_user_messages(self._store, session_id, items)
        if await _should_replace_timeline_snapshot(self._store, session_id, items):
            stored_items = await self._store.replace_timeline_snapshot(
                session_id=session_id,
                source_observed_at=params.get("sourceObservedAt"),
                items=items,
            )
        else:
            stored_items = await self._store.replace_timeline(
                session_id=session_id,
                source_observed_at=params.get("sourceObservedAt"),
                items=items,
            )
        if any(item.type == "turn.end" for item in items):
            await _reconcile_active_run_from_timeline(self._store, session_id)
        for item in items:
            if item.type != "turn.end":
                continue
            if _timeline_item_failed(item):
                await upsert_execution_error_interaction(
                    self._store,
                    session_id=session_id,
                    timeline_item=item,
                )
            else:
                await cancel_turn_blocking_interactions(
                    self._store,
                    session_id=session_id,
                    turn_id=item.turnId,
                    reason="turn_finished",
                )
        await self._session_states.reconcile(
            session_id,
            settle_stopping=any(item.type == "turn.end" for item in items),
        )
        push_items = len(stored_items) <= TIMELINE_SYNC_PUSH_LIMIT
        return IngestEffect(
            session_id=session_id,
            items=[item.model_dump(mode="json") for item in stored_items] if push_items else None,
            session_changed=True,
            notices_changed=any(item.type == "turn.end" for item in items),
            needs_refetch=not push_items,
        )

    async def _upsert(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> IngestEffect:
        item = TimelineItemIn.model_validate(params["item"])
        session_id = await _resolve_timeline_session_id(
            self._store,
            connector_id,
            params["sessionId"],
            [item],
        )
        if await _session_disabled(self._store, session_id):
            return IngestEffect()
        item = _timeline_item_for_session(item, session_id)
        item = (await _tag_active_run_user_messages(self._store, session_id, [item]))[0]
        stored = await self._store.upsert_timeline_item(
            session_id=session_id,
            source_observed_at=params.get("sourceObservedAt"),
            item=item,
        )
        if item.type == "turn.start" and item.turnId:
            await self._store.update_active_run_turn_id(session_id, item.turnId)
        if item.type == "turn.end":
            await close_waiting_approval_items_for_finished_turn(
                self._store,
                session_id,
                item,
            )
            if _timeline_item_failed(item):
                await upsert_execution_error_interaction(
                    self._store,
                    session_id=session_id,
                    timeline_item=item,
                )
            else:
                await cancel_turn_blocking_interactions(
                    self._store,
                    session_id=session_id,
                    turn_id=item.turnId,
                    reason="turn_finished",
                )
            await self._store.clear_active_run(session_id)
        await self._session_states.reconcile(
            session_id,
            settle_stopping=item.type == "turn.end",
        )
        return IngestEffect(
            session_id=session_id,
            item=stored.model_dump(mode="json"),
            session_changed=item.type in ("turn.start", "turn.end"),
            notices_changed=item.type == "turn.end",
        )


class InteractionNotificationHandler:
    METHODS: ClassVar[set[str]] = {
        "notice.upsert",
        "approval.requested",
        "runtime.error",
    }

    def __init__(
        self,
        store: ConnectorNotificationRepository,
        projections: InteractionProjectionService,
    ) -> None:
        self._store = store
        self._projections = projections
        self._session_states = SessionStateService(store)

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
            return await self._notice(params)
        if method == "approval.requested":
            return await self._approval(connector_id, params)
        return await self._runtime_error(params)

    async def _notice(self, params: dict[str, Any]) -> IngestEffect:
        try:
            notice = NoticeIn.model_validate(params)
        except ValidationError as exc:
            raise NotificationValidationError("invalid_notice", str(exc)) from exc
        if await _session_disabled(self._store, notice.sessionId):
            return IngestEffect()
        if notice.type == "interaction":
            try:
                stored = await self._projections.project_interaction(notice)
            except InteractionDomainError as exc:
                raise NotificationValidationError(
                    "invalid_interaction",
                    exc.detail,
                ) from exc
        else:
            stored = await self._store.upsert_notice(notice)
            await self._session_states.reconcile(stored.sessionId)
        return IngestEffect(
            session_id=stored.sessionId,
            session_changed=stored.blocking is not None,
            notices_changed=True,
        )

    async def _approval(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> IngestEffect:
        approval = ApprovalIn.model_validate(params)
        session_id = await _resolve_approval_session_id(
            self._store,
            connector_id,
            approval,
        )
        if await _session_disabled(self._store, session_id):
            return IngestEffect()
        await self._projections.project_approval(approval, session_id=session_id)
        return IngestEffect(
            session_id=session_id,
            approvals_changed=True,
            notices_changed=True,
            session_changed=True,
        )

    async def _runtime_error(self, params: dict[str, Any]) -> IngestEffect:
        session_id = params.get("sessionId")
        if not isinstance(session_id, str) or await _session_disabled(
            self._store,
            session_id,
        ):
            return IngestEffect()
        await upsert_execution_error_interaction(
            self._store,
            session_id=session_id,
            title="Runtime error",
            message=_string_or_none(params.get("message")),
            error={
                "code": "runtime_error",
                "message": params.get("message") or "The runtime reported an error.",
                "details": params,
            },
            reason="runtime_error",
        )
        return IngestEffect(
            session_id=session_id,
            session_changed=True,
            approvals_changed=True,
            notices_changed=True,
        )


async def _session_disabled(store: ConnectorNotificationRepository, session_id: str) -> bool:
    return await store.get_session_runtime(session_id) is None


async def _resolve_timeline_session_id(
    store: ConnectorNotificationRepository,
    connector_id: str,
    session_id: str,
    items: list[TimelineItemIn],
) -> str:
    external_session_id = next(
        (item.source.sessionId for item in items if item.source.sessionId),
        None,
    )
    try:
        return await store.resolve_connector_session_id(
            connector_id=connector_id,
            session_id=session_id,
            external_session_id=external_session_id,
        )
    except KeyError:
        return session_id


async def _resolve_approval_session_id(
    store: ConnectorNotificationRepository,
    connector_id: str,
    approval: ApprovalIn,
) -> str:
    try:
        return await store.resolve_connector_session_id(
            connector_id=connector_id,
            session_id=approval.sessionId,
            external_session_id=approval.source.sessionId,
        )
    except KeyError:
        return approval.sessionId


def _local_session_state(params: dict[str, Any]) -> str:
    value = params.get("localState") or params.get("local_state")
    if isinstance(value, str):
        normalized = value.lower()
        if normalized in {
            "active",
            "archived",
            "deleted",
            "unresumable",
            "unknown",
        }:
            return normalized
    if params.get("localArchived") is True or params.get("local_archived") is True:
        return "archived"
    if params.get("localDeleted") is True or params.get("local_deleted") is True:
        return "deleted"
    if params.get("resumeSupported") is False or params.get("resumable") is False:
        return "unresumable"
    return "active"


def _v2_session_status(value: Any) -> SessionStatus | None:
    if value is None:
        return None
    if value in {"idle", "pending", "running", "stopping", "blocked"}:
        return str(value)
    if value in {"waiting_approval", "error"}:
        return "blocked"
    return "idle"


def _string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _timeline_item_for_session(
    item: TimelineItemIn,
    session_id: str,
) -> TimelineItemIn:
    if item.sessionId == session_id:
        return item
    return TimelineItemIn.model_validate({**item.model_dump(), "sessionId": session_id})


def _timeline_item_failed(item: TimelineItemIn) -> bool:
    if item.status == "failed":
        return True
    if isinstance(item.content, dict):
        result = item.content.get("result")
        if result in {"failed", "error", "dispatch_failed"}:
            return True
        if isinstance(item.content.get("error"), dict):
            return True
    return False


async def _should_replace_timeline_snapshot(
    store: ConnectorNotificationRepository,
    session_id: str,
    items: list[TimelineItemIn],
) -> bool:
    if items:
        return all(item.source.runtime == "claude" for item in items)
    try:
        session = await store.get_session(session_id)
    except KeyError:
        return False
    return session.runtime == "claude"


async def _reconcile_active_run_from_timeline(
    store: ConnectorNotificationRepository,
    session_id: str,
) -> None:
    if await store.get_open_turn_id(session_id) is None:
        await store.clear_active_run(session_id)


async def _tag_active_run_user_messages(
    store: ConnectorNotificationRepository,
    session_id: str,
    items: list[TimelineItemIn],
) -> list[TimelineItemIn]:
    active = await store.get_active_run(session_id)
    if active is None:
        return items
    params = active.get("params")
    if not isinstance(params, dict):
        return items
    client_message_id = params.get("clientMessageId")
    expected_text = params.get("content")
    attachments = _timeline_attachments_from_active_run(params)
    if not isinstance(client_message_id, str) or not client_message_id:
        return items
    if not isinstance(expected_text, str):
        return items

    tagged: list[TimelineItemIn] = []
    did_tag = False
    for item in items:
        if did_tag or not _active_run_user_message_matches(item, expected_text):
            tagged.append(item)
            continue
        source = item.source.model_dump()
        content = item.content if isinstance(item.content, dict) else {}
        next_source = source
        next_content = content
        changed = False
        if not source.get("clientMessageId"):
            next_source = {**next_source, "clientMessageId": client_message_id}
            changed = True
        if attachments and not _content_has_attachments(content):
            next_content = {**next_content, "attachments": attachments}
            changed = True
        if not changed:
            did_tag = True
            tagged.append(item)
            continue
        tagged.append(
            TimelineItemIn.model_validate(
                {
                    **item.model_dump(),
                    "source": next_source,
                    "content": next_content,
                }
            )
        )
        did_tag = True
    return tagged


def _active_run_user_message_matches(
    item: TimelineItemIn,
    expected_text: str,
) -> bool:
    if item.type != "message" or item.role != "user":
        return False
    content = item.content if isinstance(item.content, dict) else {}
    actual_text = content.get("text")
    if not isinstance(actual_text, str):
        return False
    return _client_message_text_matches(actual_text, expected_text)


def _timeline_attachments_from_active_run(
    params: dict[str, Any],
) -> list[dict[str, Any]]:
    raw = params.get("timelineAttachments")
    if not isinstance(raw, list):
        raw = params.get("attachments")
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        file_id = entry.get("fileId")
        if not isinstance(file_id, str) or not file_id:
            continue
        attachment: dict[str, Any] = {"fileId": file_id}
        for source, target in (
            ("name", "name"),
            ("mediaType", "mediaType"),
            ("size", "size"),
            ("sha256", "sha256"),
        ):
            value = entry.get(source)
            if value is not None and target not in attachment:
                attachment[target] = value
        out.append(attachment)
    return out


def _content_has_attachments(content: dict[str, Any]) -> bool:
    attachments = content.get("attachments")
    return isinstance(attachments, list) and len(attachments) > 0


def _client_message_text_matches(actual: str, expected: str) -> bool:
    if actual == expected:
        return True
    return actual.startswith(expected) and actual[len(expected) :].startswith("\n\n[")
