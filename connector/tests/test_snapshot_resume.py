import asyncio
import hashlib
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from connector.server.ingest import ConnectorIngestClient


def test_lost_chunk_response_resumes_without_resending_persisted_chunks():
    async def run():
        chunks, writes, manifests = {}, [], []
        lose_reply = True
        committed = False

        async def receive(request):
            nonlocal lose_reply, committed
            path = request.url.path
            if path.endswith("/uploads"):
                manifests.append(json.loads(await request.aread()))
                return httpx.Response(200, json={"chunkBytes": 262144, "receivedChunks": sorted(chunks), "committed": committed})
            if "/chunks/" in path:
                index = int(path.rsplit("/", 1)[1])
                writes.append(index)
                chunks[index] = await request.aread()
                if index == 1 and lose_reply:
                    lose_reply = False
                    raise httpx.ReadError("lost persisted chunk receipt", request=request)
                return httpx.Response(200, json={"received": True})
            assert path.endswith("/commit")
            raw = b"".join(chunks[i] for i in sorted(chunks))
            assert hashlib.sha256(raw).hexdigest() == manifests[-1]["uploadId"]
            committed = True
            return httpx.Response(200, json={"committed": True})

        async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as http:
            def fresh_connector():
                return ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)
            def items():
                yield {"id": "one", "content": {"text": "x" * 800_000}}
            with pytest.raises(RuntimeError, match="lost persisted"):
                await fresh_connector().ingest_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, items(), 12)
            assert writes == [0, 1] and not committed
            await fresh_connector().ingest_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, items(), 12)
            assert writes == [0, 1, 2, 3] and committed
            assert manifests[0] == manifests[1]
            await fresh_connector().ingest_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, items(), 12)
            assert writes == [0, 1, 2, 3]
    asyncio.run(run())


def test_cancellation_closes_snapshot_file_without_advancing_receipt(monkeypatch):
    import connector.server.ingest as module
    original = module.snapshot_body
    files = []

    def capture(*args):
        body = original(*args)
        files.append(body)
        return body
    monkeypatch.setattr(module, "snapshot_body", capture)

    async def run():
        entered = asyncio.Event()
        async def receive(request):
            if request.url.path.endswith("/uploads"):
                return httpx.Response(200, json={"chunkBytes": 262144, "receivedChunks": [], "committed": False})
            entered.set()
            await asyncio.Event().wait()
        async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as http:
            client = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)
            task = asyncio.create_task(client.ingest_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, iter([]), 12))
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert files[0].closed
            assert not client.has_pending
    asyncio.run(run())
