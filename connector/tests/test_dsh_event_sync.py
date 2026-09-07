from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from connector.runtime_protocol import RuntimeInstanceHost, RuntimeInstanceSpec, timeline_content_hash
from connector.runtimes.dsh.bridge.sync import SyncRelay
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.runtime_sync import RuntimeSyncRunner


def item(item_id="one", session_id="session"):
    content = {"text": "hello", "format": "markdown"}
    return {"id": item_id, "sessionId": session_id, "type": "message", "role": "assistant",
            "status": "done", "orderSeq": 1, "revision": 1, "content": content,
            "source": {"runtime": "dsh"},
            "contentHash": timeline_content_hash("message", "done", "assistant", content)}


def host():
    return SimpleNamespace(publish_runtime_notifications=AsyncMock(), sync_state_write=AsyncMock())


def operation(kind, **values):
    return {"kind": kind, "sessionId": "session", "snapshotId": "capture", **values}


def test_snapshot_replacement_waits_for_complete_capture_and_preserves_empty_snapshot():
    async def exercise():
        receiver = host()
        relay = SyncRelay(Mock(), receiver)
        try:
            await relay.operation(operation("snapshot.begin", throughSeq=12,
                meta={"externalSessionId": "native", "cwd": "/repo"}))
            await relay.operation(operation("snapshot.items", items=[item()]))
            receiver.publish_runtime_notifications.assert_not_awaited()
            with pytest.raises(ValueError, match="Incomplete snapshot"):
                await relay.operation(operation("snapshot.commit", totalItems=2, throughSeq=12))
            receiver.publish_runtime_notifications.assert_not_awaited()
            await relay.operation(operation("snapshot.items", items=[item("two")]))
            await relay.operation(operation("snapshot.commit", totalItems=2, throughSeq=12))
            notices = receiver.publish_runtime_notifications.call_args.args[1]
            assert [n["method"] for n in notices] == ["session.meta.upsert", "timeline.sync"]
            assert notices[1]["params"]["complete"] is True
            assert [i["id"] for i in notices[1]["params"]["items"]] == ["one", "two"]
            await relay.operation(operation("snapshot.begin", throughSeq=0, meta={"externalSessionId": "native"}))
            await relay.operation(operation("snapshot.commit", totalItems=0, throughSeq=0))
            assert receiver.publish_runtime_notifications.call_args.args[1][1]["params"]["items"] == []
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_snapshot_abort_foreign_items_and_duplicate_pages_do_not_publish_partial_history():
    async def exercise():
        receiver = host()
        relay = SyncRelay(Mock(), receiver)
        try:
            await relay.operation(operation("snapshot.begin", throughSeq=1, meta={"externalSessionId": "native"}))
            with pytest.raises(ValueError, match="identity"):
                await relay.operation(operation("snapshot.items", items=[item(session_id="other")]))
            await relay.operation(operation("snapshot.items", items=[item()]))
            with pytest.raises(ValueError, match="identity"):
                await relay.operation(operation("snapshot.items", items=[item()]))
            await relay.operation(operation("snapshot.abort"))
            assert relay.file is None
            receiver.publish_runtime_notifications.assert_not_awaited()
        finally:
            await relay.close()
    asyncio.run(exercise())


@pytest.mark.parametrize("reject", [False, True])
def test_relay_ack_waits_for_ingest_and_does_not_ack_rejected_or_out_of_order_batches(reject):
    async def exercise():
        entered, release, acknowledged = asyncio.Event(), asyncio.Event(), asyncio.Event()
        acks = []

        async def publish(*args):
            entered.set()
            await release.wait()
            if reject:
                raise RuntimeError("ingest rejected")

        async def request(method, params=None):
            if method == "runtime.sync.subscribe":
                return {"streamId": "stream", "projectionVersion": 2}
            acks.append(params["batchSeq"])
            acknowledged.set()

        client = SimpleNamespace(request=request, writer=Mock())
        relay = SyncRelay(client, SimpleNamespace(publish_runtime_notifications=publish))
        relay.start()
        try:
            op = {"kind": "notifications", "notifications": [{"method": "session.state.updated", "params": {"sessionId": "session", "status": "idle"}}]}
            relay.accept({"streamId": "stream", "batchSeq": 1, "projectionVersion": 2, "operations": [op]})
            await asyncio.wait_for(entered.wait(), 1)
            assert not acks
            release.set()
            if not reject:
                await asyncio.wait_for(acknowledged.wait(), 1)
                relay.accept({"streamId": "stream", "batchSeq": 3, "projectionVersion": 2, "operations": [op]})
            await asyncio.wait_for(relay.task, 1)
            assert acks == ([] if reject else [1])
            client.writer.close.assert_called_once()
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_event_runtime_is_not_scanned_and_reconnect_is_explicit():
    async def exercise():
        runtime = SimpleNamespace(sync_mode="events", resynchronize=AsyncMock())
        supervisor = SimpleNamespace(runtimes={"dsh": runtime}, resolve_runtime=lambda _: runtime,
                                     entry=Mock(side_effect=AssertionError("scanner inspected event runtime")))
        runner = RuntimeSyncRunner(None, supervisor, host(), dict, AsyncMock())
        await runner.sync_existing_once()
        await runner.sync_existing_once()
        runtime.resynchronize.assert_not_awaited()
        await runner.reconnect_event_runtimes()
        runtime.resynchronize.assert_awaited_once_with()
    asyncio.run(exercise())


def test_instance_binds_existing_notifications_and_propagates_ingest_failure():
    async def exercise():
        ingest, background = AsyncMock(), AsyncMock()
        base = ConnectorRuntimeHost("connector", background, AsyncMock(), ingest_notifications=ingest)
        scoped = RuntimeInstanceHost(base, RuntimeInstanceSpec(runtime_id="rti_phone", runtime_type="dsh", name="DSH"))
        notices = [{"method": "timeline.itemUpsert", "params": {
            "runtime": "foreign", "runtimeId": "foreign", "sessionId": "session", "item": item()}}]
        await scoped.publish_runtime_notifications("dsh", notices)
        params = ingest.call_args.args[0][0]["params"]
        assert params["runtime"] == "dsh" and params["runtimeId"] == "rti_phone"
        background.assert_not_awaited()
        ingest.side_effect = RuntimeError("offline")
        with pytest.raises(RuntimeError, match="offline"):
            await scoped.publish_runtime_notifications("dsh", notices)
        with pytest.raises(ValueError):
            await base.publish_runtime_notifications("dsh", [{"method": "unknown", "params": {}}])
    asyncio.run(exercise())


def test_dsh_question_batches_use_existing_publishers_in_order_with_instance_binding():
    async def exercise():
        forwarded = []

        async def notify(method, params):
            forwarded.append({"method": method, "params": params})

        async def ingest(notifications):
            forwarded.extend(notifications)

        base = ConnectorRuntimeHost("connector", notify, AsyncMock(), ingest_notifications=ingest)
        scoped = RuntimeInstanceHost(base, RuntimeInstanceSpec(runtime_id="rti_phone", runtime_type="dsh", name="DSH"))
        relay = SyncRelay(Mock(), scoped)
        await relay.operation({"kind": "notifications", "notifications": [
            {"method": "timeline.itemUpsert", "params": {"sessionId": "session", "item": item()}},
            {"method": "notice.upsert", "params": {"noticeId": "q", "sessionId": "session", "runtime": "dsh",
                "type": "interaction", "interactionType": "input_request", "title": "回答问题", "status": "open",
                "responseRequired": True, "blocking": {"scope": "session", "targetId": "session"}}},
            {"method": "runtime.capability.updated", "params": {"runtime": "dsh", "revision": 2,
                "capabilities": [{"capabilityId": "session.interaction.approval", "scope": "runtime", "supported": True}]}},
            {"method": "session.state.updated", "params": {"sessionId": "session", "status": "waiting_approval"}},
        ]})
        assert [n["method"] for n in forwarded] == ["timeline.itemUpsert", "notice.upsert", "runtime.capability.updated", "session.state.updated"]
        assert forwarded[0]["params"]["runtimeId"] == "rti_phone"
        assert forwarded[1]["params"]["source"]["runtimeId"] == "rti_phone"
        assert forwarded[1]["params"]["blocking"]["targetId"] == "session"
        assert forwarded[2]["params"]["capabilities"][0]["runtimeId"] == "rti_phone"
    asyncio.run(exercise())
