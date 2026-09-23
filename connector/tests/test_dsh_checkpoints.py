from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from connector.runtime_protocol import RuntimeInstanceHost, RuntimeInstanceSpec, timeline_content_hash
from connector.runtimes.dsh.bridge.sync import SyncRelay
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.sync_state import JsonSyncStateStore


CHECKPOINT = {"version": 1, "projectionVersion": 2, "throughSeq": 12, "historyHash": "a" * 64, "settled": True}
KEY = "dsh/sync/checkpoints/native"


def bound_host(path, ingest, runtime_id="rti_dsh"):
    store = JsonSyncStateStore(path)
    base = ConnectorRuntimeHost("connector", AsyncMock(), AsyncMock(), store, ingest)
    return RuntimeInstanceHost(base, RuntimeInstanceSpec(runtime_id=runtime_id, runtime_type="dsh", name="DSH")), store


def timeline_notice():
    content = {"text": "durable hello"}
    item = {"id": "item", "sessionId": "session", "type": "message", "role": "assistant",
            "status": "done", "orderSeq": 1, "revision": 1, "content": content,
            "source": {"runtime": "dsh"},
            "contentHash": timeline_content_hash("message", "done", "assistant", content)}
    return {"method": "timeline.itemUpsert", "params": {"sessionId": "session", "item": item}}


@pytest.mark.parametrize("fail", [False, True])
def test_ingestion_precedes_checkpoint_and_ack_and_json_survives_restart(tmp_path, fail):
    async def run():
        entered, release, acked = asyncio.Event(), asyncio.Event(), asyncio.Event()
        forwarded, acks = [], []

        async def ingest(notifications):
            entered.set()
            await release.wait()
            if fail:
                raise RuntimeError("ingestion rejected")
            forwarded.extend(notifications)

        path = tmp_path / "connector-state.json"
        host, store = bound_host(path, ingest)

        async def request(method, params=None):
            if method == "runtime.sync.subscribe":
                assert params == {"checkpointVersion": 1}
                return {"streamId": "stream", "projectionVersion": 2, "checkpointVersion": 1}
            acks.append(params)
            acked.set()

        relay = SyncRelay(SimpleNamespace(request=request), host)
        task = asyncio.create_task(relay.consume())
        try:
            relay.accept({"streamId": "stream", "batchSeq": 1, "projectionVersion": 2, "operations": [
                {"kind": "notifications", "notifications": [timeline_notice()]},
                {"kind": "checkpoint.save", "externalSessionId": "native", "checkpoint": CHECKPOINT},
            ]})
            await asyncio.wait_for(entered.wait(), 1)
            assert await host.sync_state_read(KEY) is None
            assert store.flush() is False
            assert not acks
            release.set()
            if fail:
                with pytest.raises(RuntimeError, match="ingestion rejected"):
                    await task
                assert await host.sync_state_read(KEY) is None
                assert not acks
                return
            await asyncio.wait_for(acked.wait(), 1)
            assert forwarded[0]["params"]["runtimeId"] == "rti_dsh"
            assert await host.sync_state_read(KEY) == CHECKPOINT
            # A crash before flush can only cause safe retransmission.
            cold_before_flush, _ = bound_host(path, AsyncMock())
            assert await cold_before_flush.sync_state_read(KEY) is None
            assert store.flush() is True
            cold, _ = bound_host(path, AsyncMock())
            restarted = SyncRelay(SimpleNamespace(), cold)
            restarted.durable_checkpoints = True
            await restarted.operation({"kind": "checkpoint.load", "externalSessionId": "native"})
            assert restarted.loaded_checkpoint == CHECKPOINT
            other, _ = bound_host(path, AsyncMock(), runtime_id="rti_another_dsh")
            assert await other.sync_state_read(KEY) is None
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(run())


def test_load_ack_returns_checkpoint_and_invalid_version_falls_back(tmp_path):
    async def run():
        host, store = bound_host(tmp_path / "connector-state.json", AsyncMock())
        await host.sync_state_write(KEY, CHECKPOINT)
        store.flush()
        acknowledged = asyncio.Queue()

        async def request(method, params=None):
            if method == "runtime.sync.subscribe":
                return {"streamId": "s", "projectionVersion": 2, "checkpointVersion": 1}
            await acknowledged.put(params)

        relay = SyncRelay(SimpleNamespace(request=request), host)
        task = asyncio.create_task(relay.consume())
        try:
            for seq, expected in [(1, CHECKPOINT), (2, None)]:
                if seq == 2:
                    await host.sync_state_write(KEY, {**CHECKPOINT, "projectionVersion": 99})
                relay.accept({"streamId": "s", "batchSeq": seq, "projectionVersion": 2,
                    "operations": [{"kind": "checkpoint.load", "externalSessionId": "native"}]})
                ack = await asyncio.wait_for(acknowledged.get(), 1)
                assert ack["checkpoint"] == expected
            relay.durable_checkpoints = True
            await relay.operation({"kind": "checkpoint.delete", "externalSessionId": "native"})
            assert await host.sync_state_read(KEY) is None
        finally:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
    asyncio.run(run())


def test_partial_snapshot_cannot_commit_checkpoint(tmp_path):
    async def run():
        host, store = bound_host(tmp_path / "connector-state.json", AsyncMock())
        relay = SyncRelay(SimpleNamespace(), host)
        relay.durable_checkpoints = True
        await relay.operation({"kind": "snapshot.begin", "sessionId": "session", "snapshotId": "partial",
                               "throughSeq": 12, "meta": {"externalSessionId": "native"}})
        with pytest.raises(ValueError, match="committed sync boundary"):
            await relay.operation({"kind": "checkpoint.save", "externalSessionId": "native", "checkpoint": CHECKPOINT})
        assert await host.sync_state_read(KEY) is None
        assert not store.flush()
        await relay.close()
    asyncio.run(run())
