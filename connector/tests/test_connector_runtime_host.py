from __future__ import annotations

import asyncio
from typing import Any

from connector.runtime_protocol import (
    CAPABILITY_CATALOG_MODEL,
    CAPABILITY_SESSION_INTERRUPT,
    CAPABILITY_SESSION_SEND_MESSAGE,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeTimelineItem,
    SessionNotice,
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
                    "turnId": "turn_1",
                    "type": "message",
                    "status": "running",
                    "role": "assistant",
                    "content": {"text": "hi", "format": "markdown"},
                    "source": {
                        "runtime": "codex",
                        "sessionId": "thr_1",
                        "turnId": "turn_1",
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
    first = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
        sync_state_store=JsonSyncStateStore(state_path),
    )

    await first.sync_state_write("codex/history/cursor/thread_1", {"position": 7})

    second = ConnectorRuntimeHost(
        connector_id="conn_1",
        notifier=notify,
        attachment_downloader=download,
        sync_state_store=JsonSyncStateStore(state_path),
    )

    assert await second.sync_state_read("codex/history/cursor/thread_1") == {"position": 7}
    await second.sync_state_delete("codex/history/cursor/thread_1")
    assert await first.sync_state_read("codex/history/cursor/thread_1") is None


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
