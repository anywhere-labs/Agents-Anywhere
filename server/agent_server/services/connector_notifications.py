from __future__ import annotations

from typing import Any, ClassVar

from loguru import logger
from pydantic import ValidationError

from agent_server.core.models import NoticeIn, SessionStatus, TimelineItemIn
from agent_server.core.protocol import (
    ProtocolCapability,
    ProtocolCapabilitySet,
)
from agent_server.services.connector_realtime import ConnectorRealtimeService
from agent_server.services.ingest_effects import IngestEffect
from agent_server.services.repository_ports import ConnectorNotificationRepository
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
            SessionStateNotificationHandler(store),
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
            await self._update_capabilities(connector_id, params)
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
        local_state = _local_session_state(params)
        session_id = params["sessionId"]
        external_session_id = params.get("externalSessionId")
        archived = _session_meta_archived(params, local_state)
        try:
            if isinstance(external_session_id, str):
                session_id = await self._store.resolve_connector_session_id(
                    connector_id=connector_id,
                    session_id=session_id,
                    external_session_id=external_session_id,
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
            )
            if archived is not None and session.archived != archived:
                session = await self._store.set_session_archived(session.id, archived)
            return IngestEffect(session_id=session.id, session_changed=True)
        except KeyError:
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
            )
            if archived is not None and session.archived != archived:
                session = await self._store.set_session_archived(session.id, archived)
            return IngestEffect(session_id=session.id, session_changed=True)


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
        runtime = params.get("runtime") or "codex"
        external_session_id = _string_or_none(params.get("externalSessionId"))
        if external_session_id is not None:
            try:
                session_id = await self._store.resolve_connector_session_id(
                    connector_id=connector_id,
                    session_id=session_id,
                    external_session_id=external_session_id,
                )
            except KeyError:
                pass
        try:
            await self._store.get_session(session_id)
        except KeyError:
            session = await self._store.upsert_connector_session(
                connector_id=connector_id,
                session_id=session_id,
                runtime=runtime,
                external_session_id=external_session_id,
            )
            session_id = session.id
        return IngestEffect(
            session_id=session_id,
            runtime_state=runtime_state_from_session_state_params(
                session_id=session_id,
                runtime=runtime,
                external_session_id=external_session_id,
                params=params,
            ),
            session_changed=True,
        )


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
        previous_seq = await self._store.get_session_seq(session_id)
        replace_snapshot = await _should_replace_timeline_snapshot(
            self._store,
            session_id,
            items,
        )
        if replace_snapshot:
            stored_items = await self._store.replace_timeline_snapshot(
                session_id=session_id,
                source_observed_at=params.get("sourceObservedAt"),
                items=items,
                mark_read_on_change=True,
            )
        else:
            stored_items = await self._store.sync_timeline_items(
                session_id=session_id,
                source_observed_at=params.get("sourceObservedAt"),
                items=items,
                mark_read_on_change=True,
            )
        await _reconcile_active_run_from_timeline(self._store, session_id, items)
        for item in items:
            if item.type != "turn.end":
                continue
            await close_waiting_approval_items_for_finished_turn(
                self._store,
                session_id,
                item,
                mark_read_on_change=True,
            )
        changed_items = (
            stored_items
            if replace_snapshot
            else [item for item in stored_items if item.updatedSeq > previous_seq]
        )
        push_items = len(changed_items) <= TIMELINE_SYNC_PUSH_LIMIT
        return IngestEffect(
            session_id=session_id,
            items=[item.model_dump(mode="json") for item in changed_items]
            if push_items
            else None,
            timeline_reset=replace_snapshot,
            session_changed=True,
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
            mark_read_on_change=True,
        )
        if item.type == "turn.start" and item.turnId:
            await self._store.update_active_run_turn_id(session_id, item.turnId)
        if item.type == "turn.end":
            await close_waiting_approval_items_for_finished_turn(
                self._store,
                session_id,
                item,
                mark_read_on_change=True,
            )
            await self._store.clear_active_run(session_id)
        affects_run_state = _timeline_item_affects_run_state(item)
        return IngestEffect(
            session_id=session_id,
            item=stored.model_dump(mode="json"),
            session_changed=affects_run_state,
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
            return await self._notice(params)
        return await self._runtime_error(params)

    async def _notice(self, params: dict[str, Any]) -> IngestEffect:
        try:
            notice = NoticeIn.model_validate(params)
        except ValidationError as exc:
            raise NotificationValidationError("invalid_notice", str(exc)) from exc
        if await _session_disabled(self._store, notice.sessionId):
            return IngestEffect()
        return IngestEffect(
            session_id=notice.sessionId,
            notices=[notice],
            session_changed=notice.type == "interaction" or notice.blocking is not None,
            notices_changed=True,
        )

    async def _runtime_error(self, params: dict[str, Any]) -> IngestEffect:
        session_id = params.get("sessionId")
        if not isinstance(session_id, str) or await _session_disabled(
            self._store,
            session_id,
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


def capability_identity_key(
    capability: ProtocolCapability,
) -> tuple[str, str, str | None, str | None]:
    return (
        capability.capabilityId,
        capability.scope,
        capability.runtime,
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


def _local_session_state(params: dict[str, Any]) -> str:
    metadata = params.get("metadata") if isinstance(params.get("metadata"), dict) else {}
    value = (
        params.get("localState")
        or params.get("local_state")
        or metadata.get("localState")
        or metadata.get("local_state")
    )
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
    if metadata.get("hidden") is True:
        return "archived"
    return "active"


def _session_meta_archived(
    params: dict[str, Any],
    local_state: str,
) -> bool | None:
    metadata = params.get("metadata") if isinstance(params.get("metadata"), dict) else {}
    hidden = params.get("hidden")
    if hidden is None:
        hidden = metadata.get("hidden")
    if isinstance(hidden, bool):
        return hidden
    if local_state in {"archived", "deleted", "unresumable"}:
        return True
    if local_state == "active":
        return False
    return None


def _v2_session_status(value: Any) -> SessionStatus | None:
    if value is None:
        return None
    if value in {"idle", "waiting", "pending", "running", "stopping", "blocked"}:
        return str(value)
    if value in {"waiting_approval", "error"}:
        return "blocked"
    return "idle"


def _string_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) else None


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
    external_session_id: str | None,
    params: dict[str, Any],
) -> dict[str, Any]:
    return {
        "sessionId": session_id,
        "runtime": runtime,
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


def _timeline_item_affects_run_state(item: TimelineItemIn) -> bool:
    if item.type in {"turn.start", "turn.end"}:
        return True
    return _timeline_item_is_active_work(item)


def _timeline_item_is_active_work(item: TimelineItemIn) -> bool:
    if item.type == "turn.start":
        return False
    return item.status in {"pending", "running", "waiting_approval"}


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
    items: list[TimelineItemIn],
) -> None:
    active = await store.get_active_run(session_id)
    if active is None:
        return
    turn_id = active.get("turnId")
    if not isinstance(turn_id, str) or not turn_id:
        params = active.get("params")
        client_message_id = (
            params.get("clientMessageId") if isinstance(params, dict) else None
        )
        if isinstance(client_message_id, str) and client_message_id:
            tagged_candidates = [
                item
                for item in items
                if item.source.clientMessageId == client_message_id
                and item.turnId is not None
            ]
            tagged = (
                max(tagged_candidates, key=lambda item: item.orderSeq)
                if tagged_candidates
                else None
            )
            if tagged is not None:
                turn_id = tagged.turnId
        if not isinstance(turn_id, str) or not turn_id:
            turn_id = await store.get_open_turn_id(session_id)
        if isinstance(turn_id, str) and turn_id:
            await store.update_active_run_turn_id(session_id, turn_id)
    if isinstance(turn_id, str) and any(
        item.type == "turn.end" and item.turnId == turn_id for item in items
    ):
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

    active_turn_id = active.get("turnId")
    candidate_indexes = [
        index
        for index, item in enumerate(items)
        if _active_run_user_message_matches(item, expected_text)
        and (
            not isinstance(active_turn_id, str)
            or not active_turn_id
            or item.turnId == active_turn_id
        )
    ]
    if not candidate_indexes:
        return items
    target_index = max(candidate_indexes, key=lambda index: items[index].orderSeq)

    tagged: list[TimelineItemIn] = []
    for index, item in enumerate(items):
        if index != target_index:
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
        cleaned_text = _strip_codex_attachment_echo_text(content, expected_text)
        if cleaned_text is not None and cleaned_text != content.get("text"):
            next_content = {**next_content, "text": cleaned_text}
            changed = True
        if attachments and not _content_has_attachments(next_content):
            next_content = {**next_content, "attachments": attachments}
            changed = True
        if not changed:
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
    return tagged


def _active_run_user_message_matches(
    item: TimelineItemIn,
    expected_text: str,
) -> bool:
    if item.type != "message" or item.role != "user":
        return False
    if item.source.itemType == "steeringUserMessage":
        return False
    content = item.content if isinstance(item.content, dict) else {}
    actual_text = content.get("text")
    if not isinstance(actual_text, str):
        return False
    cleaned_text = _strip_codex_attachment_echo(actual_text, expected_text)
    return _client_message_text_matches(cleaned_text, expected_text)


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


def _strip_codex_attachment_echo_text(
    content: dict[str, Any],
    expected_text: str,
) -> str | None:
    actual = content.get("text")
    if not isinstance(actual, str):
        return None
    return _strip_codex_attachment_echo(actual, expected_text)


def _strip_codex_attachment_echo(actual: str, expected_text: str) -> str:
    if actual == expected_text:
        return actual
    if actual.startswith(expected_text):
        suffix = actual[len(expected_text) :].strip()
        if suffix.startswith("Attached file: ") or " Attached file: " in suffix:
            return expected_text
        if _looks_like_codex_local_attachment_path(suffix):
            return expected_text
    return actual


def _looks_like_codex_local_attachment_path(value: str) -> bool:
    normalized = value.replace("\\", "/")
    return "/.agents-anywhere/attachments/" in normalized
