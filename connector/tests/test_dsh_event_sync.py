from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from connector.runtime_protocol import (
    RuntimeInstanceHost,
    RuntimeInstanceSpec,
    timeline_content_hash,
)
from connector.runtimes.dsh.bridge.sync import SyncRelay
from connector.runtimes.dsh.runtime import DshRuntime
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.runtime_sync import RuntimeSyncRunner


def item(item_id="one", session_id="session"):
    content = {"text": "hello", "format": "markdown"}
    return {"id": item_id, "sessionId": session_id, "type": "message", "role": "assistant",
            "status": "done", "orderSeq": 1, "revision": 1, "content": content,
            "source": {"runtime": "dsh"},
            "contentHash": timeline_content_hash("message", "done", "assistant", content)}


def host():
    return SimpleNamespace(publish_runtime_notifications=AsyncMock(), sync_state_write=AsyncMock(), runtime_health_update=AsyncMock())


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
def test_relay_failure_resubscribes_without_closing_concurrent_rpc(reject):
    async def exercise():
        entered, release, acknowledged = asyncio.Event(), asyncio.Event(), asyncio.Event()
        acks = []
        subscriptions = 0
        resubscribed = asyncio.Event()

        async def publish(*args, **kwargs):
            assert kwargs["session_id"] == "session" and kwargs["runtime"] == "dsh"
            entered.set()
            await release.wait()
            if reject and subscriptions == 1:
                raise RuntimeError("delivery failed")

        async def request(method, params=None):
            nonlocal subscriptions
            if method == "runtime.sync.subscribe":
                subscriptions += 1
                if subscriptions > 1:
                    resubscribed.set()
                return {"streamId": f"stream-{subscriptions}", "projectionVersion": 2}
            acks.append(params["batchSeq"])
            acknowledged.set()

        client = SimpleNamespace(request=request, writer=Mock(), connected=True)
        relay = SyncRelay(client, SimpleNamespace(session_state_update=publish, runtime_health_update=AsyncMock()), retry_delay=0.01)
        relay.start()
        try:
            op = {"kind": "notifications", "notifications": [{"method": "session.state.updated", "params": {"sessionId": "session", "status": "idle"}}]}
            await asyncio.sleep(0)
            relay.accept({"streamId": "stream-1", "batchSeq": 1, "projectionVersion": 2, "operations": [op]})
            await asyncio.wait_for(entered.wait(), 1)
            assert not acks
            release.set()
            if not reject:
                await asyncio.wait_for(acknowledged.wait(), 1)
                relay.accept({"streamId": "stream-1", "batchSeq": 3, "projectionVersion": 2, "operations": [op]})
            await asyncio.wait_for(resubscribed.wait(), 1)
            assert acks == ([] if reject else [1])
            acknowledged.clear()
            relay.restart("stream-1")  # A delayed old error cannot stop the new feed.
            relay.accept({"streamId": "stream-2", "batchSeq": 1, "projectionVersion": 2, "operations": [op]})
            await asyncio.wait_for(acknowledged.wait(), 1)
            assert acks == ([1] if reject else [1, 1])
            client.writer.close.assert_not_called()
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


def test_legacy_workspace_inventory_does_not_write_projects_or_local_state():
    async def exercise():
        ingest = AsyncMock()
        base = ConnectorRuntimeHost("device", AsyncMock(), AsyncMock(), ingest_notifications=ingest)
        host = RuntimeInstanceHost(base, RuntimeInstanceSpec(runtime_id="rti_dsh", runtime_type="dsh", name="DSH"))
        relay = SyncRelay(Mock(), host)
        base.sync_state_write = AsyncMock()
        projects = [{"id": "native", "title": "DSH name", "path": "/repo", "sessionIds": ["session"]}]
        await relay.operation({"kind": "workspace.inventory", "complete": True, "workspaces": projects})
        ingest.assert_not_awaited()
        base.sync_state_write.assert_not_awaited()
    asyncio.run(exercise())


def test_fresh_source_state_waits_for_ingestion_and_archive_send_returns_standard_error(tmp_path):
    async def exercise():
        entered, release = asyncio.Event(), asyncio.Event()
        async def publish(*args):
            entered.set()
            await release.wait()
        runtime = DshRuntime(
            SimpleNamespace(values={"dshHome": str(tmp_path)}),
            SimpleNamespace(publish_runtime_notifications=publish),
        )
        source = {"availability": "archived", "reason": "archived_in_dsh", "observedAt": "2026-09-07T00:00:00Z"}
        runtime._request = AsyncMock(return_value={"runtime": "dsh", "sessionId": "session", "externalSessionId": "native",
            "status": "blocked", "selections": {}, "sourceState": source})
        task = asyncio.create_task(runtime.get_session_state("session", "native"))
        await asyncio.wait_for(entered.wait(), 1)
        assert not task.done()
        release.set()
        assert (await task).status == "blocked"
        runtime._request.return_value = {"ok": False, "code": "session_archived", "message": "Archived in DSH",
            "result": {"sessionId": "session", "externalSessionId": "native", "sourceState": source}}
        result = await runtime.start_turn("session", "native", "hi", client_message_id="request")
        assert result.ok is False and result.code == "session_archived"
        assert result.result["sourceState"] == source
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


def test_snapshot_buffer_reuses_small_objects_and_spills_large_captures_without_jsonl():
    async def exercise():
        relay = SyncRelay(Mock(), host())
        try:
            small = item()
            await relay.store_items([small])
            assert relay.file is None
            assert (await relay.load_items())[0] is small
            large = {"payload": "x" * (9 * 1024 * 1024)}
            await relay.store_items([large])
            assert relay.file is not None
            assert relay.items == []
            assert await relay.load_items() == [small, large]
            relay.clear_snapshot()
            assert relay.file is None
            assert relay.items == []
            assert relay.item_bytes == 0
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_runtime_is_healthy_only_after_inventory_is_delivered():
    async def run():
        receiver = host()
        relay = SyncRelay(Mock(), receiver)
        await relay.publish_notification({"method": "session.inventory.begin", "params": {"scanToken": "scan"}})
        receiver.runtime_health_update.assert_not_awaited()
        receiver.publish_runtime_notifications.side_effect = RuntimeError("ingest unavailable")
        complete = {"method": "session.inventory.complete", "params": {"scanToken": "scan", "complete": True, "sessions": []}}
        with pytest.raises(RuntimeError):
            await relay.publish_notification(complete)
        receiver.runtime_health_update.assert_not_awaited()
        receiver.publish_runtime_notifications.side_effect = None
        await relay.publish_notification(complete)
        receiver.runtime_health_update.assert_awaited_once_with("running")
    asyncio.run(run())
