from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from connector.runtime_protocol import (
    RuntimeInstanceHost,
    RuntimeInstanceSpec,
    timeline_content_hash,
)
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.sync_state import JsonSyncStateStore
from tests.dsh_sync_helpers import ingest, ready_relay

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
@pytest.mark.parametrize("projection_version", [2, 3])
def test_ingestion_precedes_checkpoint_and_ack_and_json_survives_restart(tmp_path, fail, projection_version):
    checkpoint = {**CHECKPOINT, "projectionVersion": projection_version}
    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        forwarded = []

        async def ingest_notifications(notifications):
            entered.set()
            await release.wait()
            if fail:
                raise RuntimeError("ingestion rejected")
            forwarded.extend(notifications)

        path = tmp_path / "connector-state.json"
        host, store = bound_host(path, ingest_notifications)
        relay = ready_relay(host, projection=projection_version)
        try:
            batch = asyncio.create_task(ingest(relay, {"kind": "notifications", "notifications": [timeline_notice()]}))
            await asyncio.wait_for(entered.wait(), 1)
            # The batch is not acknowledged before ingestion completes.
            assert not batch.done()
            assert await host.sync_state_read(KEY) is None
            assert store.flush() is False
            release.set()
            if fail:
                with pytest.raises(RuntimeError, match="ingestion rejected"):
                    await batch
                assert await host.sync_state_read(KEY) is None
                assert store.flush() is False
                return
            await batch  # returning from ingest is the acknowledgement
            assert forwarded[0]["params"]["runtimeId"] == "rti_dsh"
            # The plugin only saves the checkpoint once the batch was acknowledged.
            await relay.save_checkpoint("native", checkpoint)
            assert await host.sync_state_read(KEY) == checkpoint
            # A crash before flush can only cause safe retransmission.
            cold_before_flush, _ = bound_host(path, AsyncMock())
            assert await cold_before_flush.sync_state_read(KEY) is None
            assert store.flush() is True
            cold, _ = bound_host(path, AsyncMock())
            restarted = ready_relay(cold)
            assert await restarted.load_checkpoint("native") == checkpoint
            other, _ = bound_host(path, AsyncMock(), runtime_id="rti_another_dsh")
            assert await other.sync_state_read(KEY) is None
        finally:
            await relay.close()
    asyncio.run(run())


def test_load_ack_returns_checkpoint_and_invalid_version_falls_back(tmp_path):
    async def run():
        host, store = bound_host(tmp_path / "connector-state.json", AsyncMock())
        await host.sync_state_write(KEY, CHECKPOINT)
        store.flush()
        relay = ready_relay(host)

        assert await relay.load_checkpoint("native") == CHECKPOINT
        # Without durable checkpoints the stored value is never read.
        assert await ready_relay(host, durable=False).load_checkpoint("native") is None
        await host.sync_state_write(KEY, {**CHECKPOINT, "projectionVersion": 99})
        assert await relay.load_checkpoint("native") is None
        await relay.delete_checkpoint("native")
        assert await host.sync_state_read(KEY) is None
    asyncio.run(run())


def test_invalid_checkpoint_cannot_be_saved(tmp_path):
    async def run():
        host, store = bound_host(tmp_path / "connector-state.json", AsyncMock())
        relay = ready_relay(host)
        with pytest.raises(ValueError, match="Invalid DSH checkpoint"):
            await relay.save_checkpoint("native", {**CHECKPOINT, "projectionVersion": 99})
        assert await host.sync_state_read(KEY) is None
        assert not store.flush()
        await relay.close()
    asyncio.run(run())
