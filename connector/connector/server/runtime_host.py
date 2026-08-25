from __future__ import annotations

import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeAttachmentContent,
    RuntimeCapabilitySet,
    RuntimeModelCatalog,
    RuntimePermissionCatalog,
    RuntimeStatus,
    RuntimeTimelineItem,
    SessionNotice,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.server.runtime_rpc_payloads import (
    capability_set_payload,
    model_catalog_payload,
    permission_catalog_payload,
    server_payload_without_turn_data,
    session_notice_payload,
)
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
        instance_metadata = dict(metadata or {})
        payload: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": runtime,
            "runtimeId": _runtime_id_from_metadata(instance_metadata),
            "externalSessionId": external_session_id,
            "title": title,
            "cwd": cwd,
            "lastActivityAt": ordering_time,
            "sourceObservedAt": ordering_time,
            "metadata": instance_metadata,
        }
        await self._notify_server("session.meta.upsert", _drop_none(payload))

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
        instance_metadata = dict(metadata or {})
        payload: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": runtime,
            "runtimeId": _runtime_id_from_metadata(instance_metadata),
            "externalSessionId": external_session_id,
            "status": status,
            "statusReason": status_reason,
            "error": dict(error) if error is not None else None,
            "selections": selection_values,
            "metadata": instance_metadata,
        }
        await self._notify_server("session.state.updated", _drop_none(payload))

    async def runtime_capabilities_update(
        self,
        capabilities: RuntimeCapabilitySet,
    ) -> None:
        """Publish runtime-scoped capability facts to the connector transport.

        Side effects:
        - sends `runtime.capability.updated` through the backend notifier
        """

        await self._notify_server(
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

        await self._notify_server(
            "runtime.capability.updated",
            capability_set_payload(capabilities),
        )

    async def model_catalog_update(
        self,
        catalog: RuntimeModelCatalog,
    ) -> None:
        """Publish the latest runtime model catalog to the platform.

        Side effects:
        - sends `runtime.catalog.updated` through the backend notifier
        """

        await self._notify_server(
            "runtime.catalog.updated",
            {
                "runtime": catalog.runtime,
                "runtimeId": catalog.runtime_id or catalog.runtime,
                "catalogType": "model",
                "catalog": model_catalog_payload(catalog),
            },
        )

    async def permission_catalog_update(
        self,
        catalog: RuntimePermissionCatalog,
    ) -> None:
        """Publish the latest runtime permission catalog to the platform.

        Side effects:
        - sends `runtime.catalog.updated` through the backend notifier
        """

        await self._notify_server(
            "runtime.catalog.updated",
            {
                "runtime": catalog.runtime,
                "runtimeId": catalog.runtime_id or catalog.runtime,
                "catalogType": "permission",
                "catalog": permission_catalog_payload(catalog),
            },
        )

    async def timeline_sync(
        self,
        session_id: str,
        runtime: str,
        items: tuple[RuntimeTimelineItem, ...],
        external_session_id: str | None = None,
        complete: bool = False,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        instance_metadata = dict(metadata or {})
        server_items = tuple(
            item for item in items if item.type not in {"turn.start", "turn.end"}
        )
        payload: dict[str, Any] = {
            "sessionId": session_id,
            "runtime": runtime,
            "runtimeId": _runtime_id_from_metadata(instance_metadata),
            "externalSessionId": external_session_id,
            "items": [_timeline_item_payload(item) for item in server_items],
            "complete": complete,
            "metadata": instance_metadata,
        }
        started_at = time.monotonic()
        await self._notify_server("timeline.sync", _drop_none(payload))
        elapsed_ms = (time.monotonic() - started_at) * 1000
        if elapsed_ms >= 250 or len(server_items) >= 100:
            logger.info(
                "runtime host timeline sync notified runtime={} session_id={} items={} complete={} elapsed_ms={:.1f}",
                runtime,
                session_id,
                len(server_items),
                complete,
                elapsed_ms,
            )

    async def timeline_item_upsert(
        self,
        item: RuntimeTimelineItem,
    ) -> None:
        if item.type in {"turn.start", "turn.end"}:
            return
        source = item.source
        runtime_id = source.get("runtimeId")
        await self._notify_server(
            "timeline.itemUpsert",
            _drop_none(
                {
                    "sessionId": item.session_id,
                    "runtime": source.get("runtime")
                    if runtime_id is not None
                    else None,
                    "runtimeId": runtime_id,
                    "item": _timeline_item_payload(item),
                }
            ),
        )

    async def notice_upsert(
        self,
        notice: SessionNotice,
    ) -> None:
        await self._notify_server(
            "notice.upsert",
            session_notice_payload(notice),
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
        instance_details = dict(details or {})
        await self._notify_server(
            "runtime.error",
            _drop_none(
                {
                    "runtime": runtime,
                    "runtimeId": _runtime_id_from_metadata(instance_details),
                    "code": code,
                    "message": message,
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                    "details": instance_details,
                }
            ),
        )

    async def _notify_server(self, method: str, payload: Mapping[str, Any]) -> None:
        """Send a notification after enforcing the Server session-only boundary."""

        await self._notifier(method, server_payload_without_turn_data(payload))

    async def attachment_download(
        self,
        session_id: str,
        file_id: str,
    ) -> RuntimeAttachmentContent:
        content, name, media_type = await self._attachment_downloader(
            session_id, file_id
        )
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
            raise ValueError(
                "sync state key must be runtime-namespaced, e.g. codex/history/cursor/{id}"
            )
        return runtime, self._connector_id, key


def _timeline_item_payload(item: RuntimeTimelineItem) -> dict[str, Any]:
    return _drop_none(
        {
            "id": item.id,
            "sessionId": item.session_id,
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
            "runtimeType": source.get("runtimeType"),
            "runtimeId": source.get("runtimeId"),
            "sessionId": source.get("sessionId") or source.get("threadId"),
            "itemId": source.get("itemId") or item.id,
            "itemType": source.get("itemType") or source.get("rawType"),
            "event": source.get("event"),
            "derivedKey": source.get("derivedKey"),
            "clientMessageId": source.get("clientMessageId"),
        }
    )


def _drop_none(payload: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in payload.items() if value is not None}


def _sync_state_value(state: RuntimeSyncState | None) -> Mapping[str, Any] | None:
    if state is None:
        return None
    return state.cursor


def _runtime_id_from_metadata(metadata: Mapping[str, Any]) -> str | None:
    runtime_id = metadata.get("runtimeId")
    return runtime_id if isinstance(runtime_id, str) and runtime_id else None
