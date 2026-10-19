from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from connector.core.config import ConnectorConfig
from connector.runtime_protocol import (
    RuntimeInstanceHost,
    RuntimeInstanceSpec,
    timeline_content_hash,
)
from connector.server.client import BackendRpcClient
from connector.server.rpc import CONNECTOR_WS_MAX_NOTIFICATION_BYTES
from tests.dsh_sync_helpers import add_page, begin_snapshot, ingest, ready_relay


def backend_client(tmp_path):
    client = BackendRpcClient(
        ConnectorConfig("http://test", "connector", "test-only", state_path=str(tmp_path / "sync.json")),
        agent_runtime_providers=(),
    )
    client._ingest.ingest_notifications = AsyncMock()
    async def snapshot(runtime, runtime_id, session_id, meta, items, **kwargs):
        await client._ingest.ingest_notifications([
            {"method": "session.meta.upsert", "params": {"sessionId": session_id, **meta, "runtime": runtime, "runtimeId": runtime_id}},
            {"method": "timeline.sync", "params": {"sessionId": session_id, "items": list(items), "complete": True, "runtime": runtime, "runtimeId": runtime_id}},
        ])
    client._ingest.ingest_snapshot = AsyncMock(side_effect=snapshot)
    client._ingest.enqueue = AsyncMock()
    client._timeline_notifications.send = AsyncMock(wraps=client._timeline_notifications.send)
    host = RuntimeInstanceHost(client.agent_runtime_host,
        RuntimeInstanceSpec(runtime_id="rti_dsh", runtime_type="dsh", name="DSH"))
    return client, host


def item_notification(text="streaming text"):
    content = {"text": text, "format": "markdown"}
    item = {"id": "reply", "sessionId": "session", "type": "message", "role": "assistant",
        "status": "inProgress", "orderSeq": 1, "revision": 1, "content": content,
        "source": {"runtime": "dsh"},
        "contentHash": timeline_content_hash("message", "inProgress", "assistant", content)}
    return {"method": "timeline.itemUpsert", "params": {
        "sessionId": "session", "runtime": "foreign", "runtimeId": "foreign", "item": item}}


def start_relay(host, notifications, *, durable=False):
    """A registered subscription plus the plugin call that hands over one batch.

    The call returning is the acknowledgement: the relay processes every
    operation before ``Sync.ingestBatch`` answers.
    """
    relay = ready_relay(host, durable=durable)
    return relay, ingest(relay, {"kind": "notifications", "notifications": notifications})


def test_live_batch_uses_websocket_in_order_and_waits_for_send_before_ack(tmp_path):
    async def exercise():
        client, host = backend_client(tmp_path)
        entered, release = asyncio.Event(), asyncio.Event()
        frames = []

        async def send(payload):
            frames.append(json.loads(payload))
            entered.set()
            await release.wait()

        client._rpc.set_connection(SimpleNamespace(send=send))
        notices = [
            {"method": "session.meta.upsert", "params": {"sessionId": "session", "externalSessionId": "native"}},
            item_notification(),
            {"method": "session.state.updated", "params": {"sessionId": "session", "status": "running"}},
        ]
        relay, delivery = start_relay(host, notices)
        task = asyncio.create_task(delivery)
        try:
            await asyncio.wait_for(entered.wait(), 1)
            # The plugin's ingestBatch call stays unanswered until delivery finishes.
            assert not task.done()
            assert len(frames) == 1
            release.set()
            await asyncio.wait_for(task, 1)
            assert [frame["method"] for frame in frames] == [notice["method"] for notice in notices]
            assert all(frame["type"] == "notification" for frame in frames)
            assert all(frame["params"]["runtime"] == "dsh" for frame in frames)
            assert all(frame["params"]["runtimeId"] == "rti_dsh" for frame in frames)
            client._ingest.ingest_notifications.assert_not_awaited()
            client._ingest.enqueue.assert_not_awaited()
            assert client._timeline_notifications.send.await_count == len(notices)
        finally:
            await relay.close()
            client._rpc.clear_connection()

    asyncio.run(exercise())


@pytest.mark.parametrize("transport", ["offline", "oversized"])
def test_live_events_reuse_the_existing_http_fallback_queue(tmp_path, transport):
    async def exercise():
        client, host = backend_client(tmp_path)
        entered, release = asyncio.Event(), asyncio.Event()
        websocket = SimpleNamespace(send=AsyncMock())
        if transport != "offline":
            client._rpc.set_connection(websocket)

        async def enqueue(_method, _params):
            entered.set()
            await release.wait()

        client._ingest.enqueue.side_effect = enqueue
        notice = item_notification("x" * CONNECTOR_WS_MAX_NOTIFICATION_BYTES if transport == "oversized" else "text")
        relay, delivery = start_relay(host, [notice,
            {"method": "session.state.updated", "params": {"sessionId": "session", "status": "running"}},
        ])
        task = asyncio.create_task(delivery)
        try:
            await asyncio.wait_for(entered.wait(), 1)
            # Awaiting the fallback queue withholds the batch acknowledgement.
            assert not task.done()
            if transport == "oversized":
                websocket.send.assert_not_awaited()
            method, params = client._ingest.enqueue.call_args.args
            assert method == "timeline.itemUpsert"
            assert params["runtimeId"] == "rti_dsh"
            assert params["item"]["content"] == notice["params"]["item"]["content"]
            release.set()
            await asyncio.wait_for(task, 1)
            client._ingest.ingest_notifications.assert_not_awaited()
            assert client._ingest.enqueue.await_count == (2 if transport == "offline" else 1)
            assert client._timeline_notifications.send.await_count == 2
        finally:
            await relay.close()
            client._rpc.clear_connection()

    asyncio.run(exercise())


def test_complete_snapshot_and_inventory_still_use_ingest_when_websocket_is_connected(tmp_path):
    async def exercise():
        client, host = backend_client(tmp_path)
        websocket = SimpleNamespace(send=AsyncMock())
        client._rpc.set_connection(websocket)
        relay = ready_relay(host)
        try:
            await ingest(relay, {"kind": "notifications", "notifications": [
                {"method": "session.inventory.begin", "params": {"syncId": "inventory"}},
            ]})
            await begin_snapshot(relay, meta={"externalSessionId": "native", "cwd": "/repo"}, through_seq=1)
            await add_page(relay, [item_notification()["params"]["item"]])
            assert client._ingest.ingest_notifications.await_count == 1
            assert (await relay.commit_snapshot()).accepted is True
            await ingest(relay, {"kind": "notifications", "notifications": [
                {"method": "session.inventory.complete", "params": {"syncId": "inventory"}},
            ]})
            batches = [call.args[0] for call in client._ingest.ingest_notifications.await_args_list]
            assert [[notice["method"] for notice in batch] for batch in batches] == [
                ["session.inventory.begin"], ["session.meta.upsert", "timeline.sync"], ["session.inventory.complete"],
            ]
            assert batches[1][1]["params"]["complete"] is True
            assert all(notice["params"]["runtimeId"] == "rti_dsh" for batch in batches for notice in batch)
            websocket.send.assert_not_awaited()
            client._ingest.enqueue.assert_not_awaited()
        finally:
            await relay.close()
            client._rpc.clear_connection()

    asyncio.run(exercise())
