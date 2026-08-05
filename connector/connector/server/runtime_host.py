from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from connector.runtime_protocol import (
    RuntimeAttachmentContent,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeStatus,
    RuntimeTimelineItem,
    SessionNotice,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.server.sync_state import RuntimeSyncState, SyncStateStore

BackendNotifier = Callable[[str, dict[str, Any]], Awaitable[None]]
AttachmentDownloader = Callable[[str, str], Awaitable[tuple[bytes, str, str]]]


class ConnectorRuntimeHost(RuntimeHostClient):
    """Map Agent Runtime Protocol host calls onto current connector notifications."""

    def __init__(
        self,
        connector_id: str,
        notifier: BackendNotifier,
        attachment_downloader: AttachmentDownloader,
        sync_state_store: SyncStateStore | None = None,
    ) -> None:
        self._connector_id = connector_id
        self._notifier = notifier
        self._attachment_downloader = attachment_downloader
        self._sync_state_store = sync_state_store
        self._memory_sync_state: dict[str, Mapping[str, Any]] = {}

    @property
    def connector_id(self) -> str:
        return self._connector_id

    async def session_meta_upsert(
        self,
        session_id: str,
        runtime: str,
        external_session_id: str | None = None,
        title: str | None = None,
        cwd: str | None = None,
        ordering_time: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": runtime,
            "externalSessionId": external_session_id,
            "title": title,
            "cwd": cwd,
            "lastActivityAt": ordering_time,
            "sourceObservedAt": ordering_time,
            "metadata": dict(metadata or {}),
        }
        await self._notifier("session.meta.upsert", _drop_none(payload))

    async def session_state_update(
        self,
        session_id: str,
        runtime: str,
        status: RuntimeStatus | None = None,
        selections: Mapping[str, str | None] | None = None,
        external_session_id: str | None = None,
        status_reason: str | None = None,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        selection_values = dict(selections or {})
        payload: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": runtime,
            "externalSessionId": external_session_id,
            "status": status,
            "statusReason": status_reason,
            "error": dict(error) if error is not None else None,
            "selections": selection_values,
            "metadata": dict(metadata or {}),
        }
        await self._notifier("session.state.updated", _drop_none(payload))

    async def runtime_capabilities_update(
        self,
        capabilities: RuntimeCapabilitySet,
    ) -> None:
        """Publish runtime-scoped capability facts to the connector transport.

        Side effects:
        - sends `runtime.capability.updated` through the backend notifier
        """

        await self._notifier(
            "runtime.capability.updated",
            capability_set_payload(capabilities),
        )

    async def session_capabilities_update(
        self,
        capabilities: RuntimeCapabilitySet,
    ) -> None:
        """Publish session-scoped capability facts to the connector transport.

        Side effects:
        - sends `runtime.capability.updated` through the backend notifier
        """

        await self._notifier(
            "runtime.capability.updated",
            capability_set_payload(capabilities),
        )

    async def timeline_sync(
        self,
        session_id: str,
        runtime: str,
        items: tuple[RuntimeTimelineItem, ...],
        external_session_id: str | None = None,
        complete: bool = True,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": runtime,
            "externalSessionId": external_session_id,
            "items": [_timeline_item_payload(item) for item in items],
            "complete": complete,
            "metadata": dict(metadata or {}),
        }
        await self._notifier("timeline.sync", _drop_none(payload))

    async def timeline_item_upsert(
        self,
        item: RuntimeTimelineItem,
    ) -> None:
        await self._notifier(
            "timeline.itemUpsert",
            {
                "sessionId": item.session_id,
                "item": _timeline_item_payload(item),
            },
        )

    async def notice_upsert(
        self,
        notice: SessionNotice,
    ) -> None:
        await self._notifier(
            "notice.upsert",
            _drop_none(
                {
                    "noticeId": notice.notice_id,
                    "sessionId": notice.session_id,
                    "source": {"runtime": notice.runtime, **dict(notice.source)},
                    "type": notice.type,
                    "title": notice.title,
                    "message": notice.message,
                    "severity": notice.severity,
                    "status": notice.status,
                    "interactionType": notice.interaction_type,
                    "blocking": dict(notice.blocking) if notice.blocking is not None else None,
                    "responseRequired": notice.response_required,
                    "actions": [dict(action) for action in notice.actions],
                    "context": dict(notice.context),
                    "metadata": dict(notice.metadata),
                }
            ),
        )

    async def runtime_error(
        self,
        runtime: str,
        code: str,
        message: str,
        session_id: str | None = None,
        external_session_id: str | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        await self._notifier(
            "runtime.error",
            _drop_none(
                {
                    "runtime": runtime,
                    "code": code,
                    "message": message,
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                    "details": dict(details or {}),
                }
            ),
        )

    async def attachment_download(
        self,
        session_id: str,
        file_id: str,
    ) -> RuntimeAttachmentContent:
        content, name, media_type = await self._attachment_downloader(session_id, file_id)
        return RuntimeAttachmentContent(
            file_id=file_id,
            name=name,
            media_type=media_type,
            content=content,
        )

    async def sync_state_read(
        self,
        key: str,
    ) -> Mapping[str, Any] | None:
        if self._sync_state_store is None:
            return self._memory_sync_state.get(key)
        state = self._sync_state_store.get(*self._sync_state_key(key))
        return _sync_state_value(state)

    async def sync_state_write(
        self,
        key: str,
        value: Mapping[str, Any],
    ) -> None:
        if self._sync_state_store is None:
            self._memory_sync_state[key] = dict(value)
            return
        runtime, connector_id, state_key = self._sync_state_key(key)
        self._sync_state_store.set(
            runtime,
            connector_id,
            state_key,
            cursor=dict(value),
            metadata={"key": key},
        )

    async def sync_state_delete(
        self,
        key: str,
    ) -> None:
        if self._sync_state_store is None:
            self._memory_sync_state.pop(key, None)
            return
        self._sync_state_store.delete(*self._sync_state_key(key))

    def _sync_state_key(self, key: str) -> tuple[str, str, str]:
        runtime, separator, _rest = key.partition("/")
        if not separator or not runtime:
            raise ValueError("sync state key must be runtime-namespaced, e.g. codex/history/cursor/{id}")
        return runtime, self._connector_id, key


def _timeline_item_payload(item: RuntimeTimelineItem) -> dict[str, Any]:
    return _drop_none(
        {
            "id": item.id,
            "sessionId": item.session_id,
            "turnId": item.turn_id,
            "type": item.type,
            "status": item.status,
            "role": item.role,
            "content": dict(item.content),
            "source": _timeline_source_payload(item),
            "orderSeq": item.order_seq,
            "revision": item.revision,
            "contentHash": item.content_hash,
        }
    )


def _timeline_source_payload(item: RuntimeTimelineItem) -> dict[str, Any]:
    source = dict(item.source)
    return _drop_none(
        {
            "runtime": source.get("runtime"),
            "sessionId": source.get("sessionId") or source.get("threadId"),
            "turnId": source.get("turnId") or item.turn_id,
            "itemId": source.get("itemId") or item.id,
            "itemType": source.get("itemType") or source.get("rawType"),
            "event": source.get("event"),
            "derivedKey": source.get("derivedKey"),
            "clientMessageId": source.get("clientMessageId"),
        }
    )


def capability_set_payload(capabilities: RuntimeCapabilitySet) -> dict[str, Any]:
    return _drop_none(
        {
            "runtime": capabilities.runtime,
            "revision": capabilities.revision,
            "sessionId": capabilities.session_id,
            "connectorId": capabilities.connector_id,
            "capabilities": [
                capability_payload(capability)
                for capability in capabilities.capabilities
            ],
            "metadata": dict(capabilities.metadata),
        }
    )


def capability_payload(capability: RuntimeCapability) -> dict[str, Any]:
    return _drop_none(
        {
            "capabilityId": capability.capability_id,
            "version": capability.version,
            "scope": capability.scope,
            "runtime": capability.runtime,
            "sessionId": capability.session_id,
            "connectorId": capability.connector_id,
            "supported": capability.supported,
            "available": capability.available,
            "allowed": capability.allowed,
            "unavailableReason": capability.unavailable_reason,
            "metadata": dict(capability.metadata),
        }
    )


def _drop_none(payload: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}


def _sync_state_value(state: RuntimeSyncState | None) -> Mapping[str, Any] | None:
    if state is None:
        return None
    return state.cursor
