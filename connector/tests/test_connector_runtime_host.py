from __future__ import annotations

import asyncio
from typing import Any

from connector.runtime_protocol import (
    CAPABILITY_CATALOG_MODEL,
    CAPABILITY_SESSION_INTERRUPT,
    CAPABILITY_SESSION_SEND_MESSAGE,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeTimelineItem,
    SessionNotice,
    SessionSourceObservation,
    SessionSourceState,
)
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.sync_state import JsonSyncStateStore


def test_connector_runtime_host_maps_timeline_item_to_backend_notification() -> None:
    asyncio.run(_exercise_timeline_item_notification())


def test_connector_runtime_host_persists_sync_state(tmp_path) -> None:
    asyncio.run(_exercise_persistent_sync_state(tmp_path))


def test_connector_runtime_host_maps_notice_context_to_backend_notification() -> None:
    asyncio.run(_exercise_notice_notification())


def test_connector_runtime_host_maps_runtime_capabilities_to_backend_notification() -> None:
    asyncio.run(_exercise_runtime_capability_notification())


def test_connector_runtime_host_maps_session_capabilities_to_backend_notification() -> None:
    asyncio.run(_exercise_session_capability_notification())


def test_connector_runtime_host_maps_session_source_observation() -> None:
    asyncio.run(_exercise_session_source_notification())


def test_connector_runtime_host_maps_catalogs_to_backend_notifications() -> None:
    asyncio.run(_exercise_runtime_catalog_notifications())


def test_connector_runtime_host_preserves_named_catalog_scope() -> None:
    asyncio.run(_exercise_named_runtime_catalog_notifications())


async def _exercise_timeline_item_notification() -> None:
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    async def download(session_id: str, file_id: str) -> tuple[bytes, str, str]:
        _ = session_id
        return b"data", f"{file_id}.txt", "text/plain"

    host = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
    )

    await host.timeline_item_upsert(
        RuntimeTimelineItem(
            id="item_1",
            session_id="sess_1",
            type="message",
            status="running",
            order_seq=7,
            content_hash="sha256:abc",
            role="assistant",
            turn_id="turn_1",
            content={"text": "hi", "format": "markdown"},
            source={
                "runtime": "codex",
                "threadId": "thr_1",
                "rawType": "agentMessage",
                "event": "item/agentMessage/delta",
            },
            revision=3,
        )
    )

    assert notifications == [
        (
            "timeline.itemUpsert",
            {
                "sessionId": "sess_1",
                "item": {
                    "id": "item_1",
                    "sessionId": "sess_1",
                    "type": "message",
                    "status": "running",
                    "role": "assistant",
                    "content": {"text": "hi", "format": "markdown"},
                    "source": {
                        "runtime": "codex",
                        "sessionId": "thr_1",
                        "itemId": "item_1",
                        "itemType": "agentMessage",
                        "event": "item/agentMessage/delta",
                    },
                    "orderSeq": 7,
                    "revision": 3,
                    "contentHash": "sha256:abc",
                },
            },
        )
    ]


async def _exercise_session_source_notification() -> None:
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    async def download(session_id: str, file_id: str) -> tuple[bytes, str, str]:
        raise AssertionError(f"unexpected download: {session_id}/{file_id}")

    host = ConnectorRuntimeHost("conn_1", notify, download)
    await host.session_source_update(
        SessionSourceObservation(
            session_id="sess_1",
            external_session_id="thread_1",
            runtime="codex",
            runtime_id="rti_codex_one",
            state=SessionSourceState(
                availability="archived",
                reason="thread/archived",
                observed_at="2026-08-27T12:00:00Z",
                observation_origin="event",
            ),
        )
    )

    assert notifications == [
        (
            "session.source.updated",
            {
                "sessionId": "sess_1",
                "externalSessionId": "thread_1",
                "runtime": "codex",
                "runtimeId": "rti_codex_one",
                "availability": "archived",
                "reason": "thread/archived",
                "observedAt": "2026-08-27T12:00:00Z",
                "observationOrigin": "event",
            },
        )
    ]


async def _exercise_runtime_capability_notification() -> None:
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    async def download(session_id: str, file_id: str) -> tuple[bytes, str, str]:
        _ = session_id
        return b"data", f"{file_id}.txt", "text/plain"

    host = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
    )

    await host.runtime_capabilities_update(
        RuntimeCapabilitySet(
            runtime="codex",
            revision=21,
            connector_id="conn_1",
            capabilities=(
                RuntimeCapability(
                    capability_id=CAPABILITY_CATALOG_MODEL,
                    scope="runtime",
                    runtime="codex",
                    connector_id="conn_1",
                    metadata={"source": "codex.catalog"},
                ),
            ),
            metadata={"source": "codex.runtime"},
        )
    )

    assert notifications == [
        (
            "runtime.capability.updated",
            {
                "runtime": "codex",
                "revision": 21,
                "connectorId": "conn_1",
                "capabilities": [
                    {
                        "capabilityId": CAPABILITY_CATALOG_MODEL,
                        "version": "1",
                        "scope": "runtime",
                        "runtime": "codex",
                        "connectorId": "conn_1",
                        "supported": True,
                        "available": True,
                        "allowed": True,
                        "metadata": {"source": "codex.catalog"},
                    }
                ],
                "metadata": {"source": "codex.runtime"},
            },
        )
    ]


async def _exercise_runtime_catalog_notifications() -> None:
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    async def download(session_id: str, file_id: str) -> tuple[bytes, str, str]:
        _ = session_id
        return b"data", f"{file_id}.txt", "text/plain"

    host = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
    )

    await host.model_catalog_update(
        RuntimeModelCatalog(
            runtime="codex",
            revision=1,
            models=(
                RuntimeModelItem(
                    id="gpt-test",
                    title="GPT Test",
                    selection_id="sel_model_test",
                ),
            ),
        )
    )
    await host.permission_catalog_update(
        RuntimePermissionCatalog(
            runtime="codex",
            revision=2,
            permissions=(
                RuntimePermissionItem(
                    id="full-access",
                    title="Full access",
                    selection_id="sel_permission_full",
                ),
            ),
        )
    )

    assert notifications == [
        (
            "runtime.catalog.updated",
            {
                "runtime": "codex",
                "runtimeId": "codex",
                "catalogType": "model",
                "catalog": {
                    "runtime": "codex",
                    "revision": 1,
                    "models": [
                        {
                            "id": "gpt-test",
                            "displayName": "GPT Test",
                            "selectionId": "sel_model_test",
                            "description": None,
                            "default": False,
                            "reasoningItems": [],
                            "metadata": {"enabled": True},
                        }
                    ],
                },
            },
        ),
        (
            "runtime.catalog.updated",
            {
                "runtime": "codex",
                "runtimeId": "codex",
                "catalogType": "permission",
                "catalog": {
                    "runtime": "codex",
                    "revision": 2,
                    "permissions": [
                        {
                            "id": "full-access",
                            "displayName": "Full access",
                            "selectionId": "sel_permission_full",
                            "description": None,
                            "default": False,
                            "metadata": {"enabled": True},
                        }
                    ],
                },
            },
        ),
    ]


async def _exercise_named_runtime_catalog_notifications() -> None:
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    async def download(session_id: str, file_id: str) -> tuple[bytes, str, str]:
        _ = session_id
        return b"data", f"{file_id}.txt", "text/plain"

    host = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
    )

    await host.model_catalog_update(
        RuntimeModelCatalog(
            runtime="dsh",
            runtime_id="rti_dsh_home_01",
            revision=31,
            models=(),
        )
    )
    await host.permission_catalog_update(
        RuntimePermissionCatalog(
            runtime="codex",
            runtime_id="rti_codex_work_01",
            revision=32,
            permissions=(),
        )
    )

    assert notifications == [
        (
            "runtime.catalog.updated",
            {
                "runtime": "dsh",
                "runtimeId": "rti_dsh_home_01",
                "catalogType": "model",
                "catalog": {
                    "runtime": "dsh",
                    "runtimeId": "rti_dsh_home_01",
                    "revision": 31,
                    "models": [],
                },
            },
        ),
        (
            "runtime.catalog.updated",
            {
                "runtime": "codex",
                "runtimeId": "rti_codex_work_01",
                "catalogType": "permission",
                "catalog": {
                    "runtime": "codex",
                    "runtimeId": "rti_codex_work_01",
                    "revision": 32,
                    "permissions": [],
                },
            },
        ),
    ]


async def _exercise_session_capability_notification() -> None:
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    async def download(session_id: str, file_id: str) -> tuple[bytes, str, str]:
        _ = session_id
        return b"data", f"{file_id}.txt", "text/plain"

    host = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
    )

    await host.session_capabilities_update(
        RuntimeCapabilitySet(
            runtime="codex",
            revision=22,
            session_id="sess_1",
            connector_id="conn_1",
            capabilities=(
                RuntimeCapability(
                    capability_id=CAPABILITY_SESSION_SEND_MESSAGE,
                    scope="session",
                    runtime="codex",
                    session_id="sess_1",
                    connector_id="conn_1",
                    available=False,
                    unavailable_reason="session_running",
                ),
                RuntimeCapability(
                    capability_id=CAPABILITY_SESSION_INTERRUPT,
                    scope="session",
                    runtime="codex",
                    session_id="sess_1",
                    connector_id="conn_1",
                    available=True,
                ),
            ),
        )
    )

    assert notifications == [
        (
            "runtime.capability.updated",
            {
                "runtime": "codex",
                "revision": 22,
                "sessionId": "sess_1",
                "connectorId": "conn_1",
                "capabilities": [
                    {
                        "capabilityId": CAPABILITY_SESSION_SEND_MESSAGE,
                        "version": "1",
                        "scope": "session",
                        "runtime": "codex",
                        "sessionId": "sess_1",
                        "connectorId": "conn_1",
                        "supported": True,
                        "available": False,
                        "allowed": True,
                        "unavailableReason": "session_running",
                        "metadata": {},
                    },
                    {
                        "capabilityId": CAPABILITY_SESSION_INTERRUPT,
                        "version": "1",
                        "scope": "session",
                        "runtime": "codex",
                        "sessionId": "sess_1",
                        "connectorId": "conn_1",
                        "supported": True,
                        "available": True,
                        "allowed": True,
                        "metadata": {},
                    },
                ],
                "metadata": {},
            },
        )
    ]


async def _exercise_notice_notification() -> None:
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    async def download(session_id: str, file_id: str) -> tuple[bytes, str, str]:
        _ = session_id
        return b"data", f"{file_id}.txt", "text/plain"

    host = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
    )

    await host.notice_upsert(
        SessionNotice(
            notice_id="notice_1",
            session_id="sess_1",
            runtime="codex",
            type="interaction",
            title="Approve command",
            message="Run ls?",
            severity="warning",
            interaction_type="approval",
            blocking={"scope": "session", "targetId": "sess_1"},
            response_required=True,
            source={"approvalId": "appr_1", "timelineItemId": "item_1"},
            actions=(
                {"actionId": "approve", "label": "Approve", "style": "primary"},
                {"actionId": "reject", "label": "Reject", "style": "danger"},
            ),
            context={
                "approvalId": "appr_1",
                "approvalSource": {"requestId": 42},
            },
        )
    )

    assert notifications == [
        (
            "notice.upsert",
            {
                "noticeId": "notice_1",
                "sessionId": "sess_1",
                "source": {
                    "runtime": "codex",
                    "approvalId": "appr_1",
                    "timelineItemId": "item_1",
                },
                "type": "interaction",
                "title": "Approve command",
                "message": "Run ls?",
                "severity": "warning",
                "status": "open",
                "interactionType": "approval",
                "blocking": {"scope": "session", "targetId": "sess_1"},
                "responseRequired": True,
                "actions": [
                    {"actionId": "approve", "label": "Approve", "style": "primary"},
                    {"actionId": "reject", "label": "Reject", "style": "danger"},
                ],
                "context": {
                    "approvalId": "appr_1",
                    "approvalSource": {"requestId": 42},
                },
                "metadata": {},
            },
        )
    ]


async def _exercise_persistent_sync_state(tmp_path) -> None:
    async def notify(method: str, params: dict[str, Any]) -> None:
        _ = method, params

    async def download(session_id: str, file_id: str) -> tuple[bytes, str, str]:
        _ = session_id
        return b"data", f"{file_id}.txt", "text/plain"

    state_path = tmp_path / "connector-state.json"
    first_store = JsonSyncStateStore(state_path)
    first = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
        sync_state_store=first_store,
    )

    await first.sync_state_write("codex/history/cursor/thread_1", {"position": 7})
    assert first_store.flush() is True

    second_store = JsonSyncStateStore(state_path)
    second = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
        sync_state_store=second_store,
    )

    assert await second.sync_state_read("codex/history/cursor/thread_1") == {
        "position": 7
    }
    await second.sync_state_delete("codex/history/cursor/thread_1")
    assert await second.sync_state_read("codex/history/cursor/thread_1") is None
    assert second_store.flush() is True

    restored = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
        sync_state_store=JsonSyncStateStore(state_path),
    )
    assert await restored.sync_state_read("codex/history/cursor/thread_1") is None


def test_connector_runtime_host_maps_attachment_download() -> None:
    asyncio.run(_exercise_attachment_download())


async def _exercise_attachment_download() -> None:
    async def notify(method: str, params: dict[str, Any]) -> None:
        _ = method
        _ = params

    async def download(session_id: str, file_id: str) -> tuple[bytes, str, str]:
        assert session_id == "sess_1"
        assert file_id == "file_1"
        return b"data", "example.txt", "text/plain"

    host = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
    )

    content = await host.attachment_download("sess_1", "file_1")

    assert content.content == b"data"
    assert content.name == "example.txt"
    assert content.media_type == "text/plain"
