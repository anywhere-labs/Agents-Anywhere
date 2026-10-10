from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from connector.runtime_protocol import (
    RuntimeInstanceHost,
    RuntimeInstanceSpec,
    timeline_content_hash,
)
from connector.runtimes.dsh.bridge.sync import SyncRelay
from connector.server.ingest import ConnectorIngestClient
from connector.server.runtime_host import ConnectorRuntimeHost


@pytest.mark.parametrize("reject", [False, True])
def test_slow_snapshot_upload_keeps_ack_pending_until_cloud_acceptance(reject):
    async def run():
        uploaded, release, acked = asyncio.Event(), asyncio.Event(), asyncio.Event()
        checkpoints, progress, acks, bodies = {}, [], [], []
        timer = None
        expired = False
        relay_task = None

        def expire():
            nonlocal expired
            expired = True
            relay_task.cancel()

        def renew():
            nonlocal timer
            if timer is not None:
                timer.cancel()
            timer = asyncio.get_running_loop().call_later(0.15, expire)

        class SlowUplink(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request):
                chunks = []
                async for chunk in request.stream:
                    # 64 KiB takes 40 ms: total upload exceeds the 150 ms ACK window.
                    await asyncio.sleep(0.04 * max(1, len(chunk) / 65_536))
                    chunks.append(chunk)
                bodies.append(json.loads(b"".join(chunks)))
                uploaded.set()
                await release.wait()
                return httpx.Response(200, json={"rejected": [{"method": "timeline.sync", "code": "invalid", "message": "rejected"}]} if reject else {})

        async with httpx.AsyncClient(transport=SlowUplink()) as http:
            ingest = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)
            base = ConnectorRuntimeHost("device", AsyncMock(), AsyncMock(), ingest_notifications=ingest.ingest_notifications)
            host = RuntimeInstanceHost(base, RuntimeInstanceSpec(runtime_id="rti_dsh", runtime_type="dsh", name="DSH"))

            async def request(method, params):
                if method == "runtime.sync.subscribe":
                    return {"streamId": "stream", "projectionVersion": 3, "checkpointVersion": 1, "uploadProgressVersion": 1}
                if method == "runtime.sync.progress":
                    assert params["streamId"] == "stream" and params["batchSeq"] == 1
                    assert not progress or params["bytesSent"] > progress[-1]
                    progress.append(params["bytesSent"])
                    renew()
                    return {"ok": True}
                assert method == "runtime.sync.ack"
                acks.append(params)
                acked.set()
                timer.cancel()

            relay = SyncRelay(SimpleNamespace(request=request), host)
            relay_task = asyncio.create_task(relay.consume())
            content = {"text": "中" * 180_000}
            item = {"id": "reply", "sessionId": "session", "type": "message", "role": "assistant", "status": "done", "orderSeq": 1, "revision": 1, "content": content, "source": {"runtime": "dsh"}, "contentHash": timeline_content_hash("message", "done", "assistant", content)}
            identity = {"sessionId": "session", "snapshotId": "snapshot"}
            await relay.operation({"kind": "snapshot.begin", **identity, "meta": {"externalSessionId": "native"}, "throughSeq": 12})
            await relay.operation({"kind": "snapshot.items", **identity, "items": [item]})
            checkpoint = {"version": 1, "projectionVersion": 3, "throughSeq": 12, "historyHash": "a" * 64, "settled": True}
            base.sync_state_write = AsyncMock(side_effect=lambda key, value: checkpoints.update({key: value}))
            relay.accept({"streamId": "stream", "batchSeq": 1, "projectionVersion": 3, "operations": [
                {"kind": "snapshot.commit", **identity, "totalItems": 1, "throughSeq": 12},
                {"kind": "checkpoint.save", "externalSessionId": "native", "checkpoint": checkpoint},
            ]})
            renew()
            try:
                await asyncio.wait_for(uploaded.wait(), 2)
                assert not expired and len(progress) >= 3
                assert not acks and not checkpoints
                assert bodies[0]["notifications"][1]["params"]["items"][0]["content"] == content
                assert all(n["params"]["runtimeId"] == "rti_dsh" for n in bodies[0]["notifications"])
                release.set()
                if reject:
                    with pytest.raises(RuntimeError, match="rejected"):
                        await relay_task
                    assert not acks and not checkpoints
                else:
                    await asyncio.wait_for(acked.wait(), 1)
                    assert len(acks) == 1
                    assert checkpoints[host.instance_sync_key("dsh/sync/checkpoints/native")] == checkpoint
            finally:
                timer.cancel()
                relay_task.cancel()
                await asyncio.gather(relay_task, return_exceptions=True)
    asyncio.run(run())


def test_progress_survives_queued_requests_and_a_401_body_replay():
    async def run():
        written, requests = [], []
        tokens = AsyncMock(side_effect=["old", "new", "new"])

        async def receive(request):
            requests.append(request)
            return httpx.Response(401 if len(requests) == 1 else 200, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as http:
            ingest = ConnectorIngestClient("http://test", tokens, lambda: http, lambda _: http)
            await ingest.enqueue("session.meta.upsert", {"sessionId": "older"})

            async def progress(count):
                written.append(count)

            await ingest.ingest_notifications([{"method": "timeline.sync", "params": {"items": [{"text": "x" * 200_000}], "complete": True}}], on_progress=progress)
            assert len(requests) == 3
            assert requests[0].content == requests[1].content
            assert json.loads(requests[2].content)["notifications"][0]["method"] == "timeline.sync"
            assert sum(written) == sum(len(request.content) for request in requests)
            assert max(written) <= 65_536
            assert all(request.headers["content-length"] == str(len(request.content)) for request in requests)
            assert [request.headers["authorization"] for request in requests] == ["Bearer old", "Bearer new", "Bearer new"]
    asyncio.run(run())


def test_failed_write_does_not_report_progress_for_unwritten_bytes():
    async def run():
        written = []

        class StalledUplink(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request):
                chunks = request.stream.__aiter__()
                await anext(chunks)
                await anext(chunks)
                assert written == [65_536]
                raise httpx.WriteTimeout("uplink stalled", request=request)

        async with httpx.AsyncClient(transport=StalledUplink()) as http:
            ingest = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)

            async def progress(count):
                written.append(count)

            with pytest.raises(RuntimeError, match="uplink stalled"):
                await ingest.ingest_notifications([{"method": "timeline.sync", "params": {"items": [{"text": "x" * 200_000}]}}], on_progress=progress)
            assert written == [65_536]
    asyncio.run(run())
