from __future__ import annotations

import asyncio
import hashlib
import json
from unittest.mock import AsyncMock

import httpx
import pytest
from connector.server.errors import ConnectorNetworkError
from connector.server.ingest import ConnectorIngestClient, ConnectorIngestRejectedError


@pytest.mark.parametrize("failure", [None, 413, 503, "rejected", "lost_commit"])
def test_snapshot_chunks_remain_staged_until_commit_and_progress_matches_sent_bytes(failure):
    async def run():
        chunks = {}
        progress = []
        manifest = None
        committed = False
        lose_commit = failure == "lost_commit"

        async def receive(request):
            nonlocal manifest, committed, lose_commit
            if request.url.path.endswith("/uploads"):
                manifest = json.loads(await request.aread())
                return httpx.Response(200, json={"chunkBytes": 262144, "receivedChunks": sorted(chunks), "committed": committed})
            if "/chunks/" in request.url.path:
                if failure in (413, 503):
                    return httpx.Response(failure)
                index = int(request.url.path.rsplit("/", 1)[1])
                chunks[index] = await request.aread()
                assert len(chunks[index]) <= 262144
                return httpx.Response(200, json={"received": True})
            assert request.url.path.endswith("/commit")
            raw = b"".join(chunks[i] for i in sorted(chunks))
            assert hashlib.sha256(raw).hexdigest() == manifest["uploadId"]
            assert len(raw) == manifest["totalBytes"]
            sync = json.loads(raw)["notifications"][-1]["params"]
            assert sync["complete"] is True and sync["snapshotSeq"] == 17
            assert len(sync["items"]) == 12
            if failure == "rejected":
                return httpx.Response(200, json={"committed": False})
            committed = True
            if lose_commit:
                lose_commit = False
                raise httpx.ReadError("lost commit receipt", request=request)
            return httpx.Response(200, json={"committed": True})

        async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as http:
            def client():
                return ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)
            def items():
                for index in range(12):
                    yield {"id": str(index), "orderSeq": index, "content": {"text": "x" * 50000}}
            async def report(size):
                progress.append(size)
            async def upload():
                await client().ingest_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, items(), 17, on_progress=report)
            if failure is None:
                await upload()
                assert committed and len(chunks) >= 3
                assert sum(progress) == manifest["totalBytes"]
            else:
                error = {413: httpx.HTTPStatusError, 503: ConnectorNetworkError,
                         "rejected": ConnectorIngestRejectedError, "lost_commit": ConnectorNetworkError}[failure]
                with pytest.raises(error):
                    await upload()
                assert committed is (failure == "lost_commit")
                if committed:
                    sent = sum(progress)
                    await upload()
                    assert sum(progress) == sent
    asyncio.run(run())


def test_authentication_retry_replays_same_chunk_and_reuses_refreshed_credentials():
    async def run():
        bodies = []
        tokens = AsyncMock(side_effect=lambda force: "new" if force else "old")
        async def receive(request):
            if request.url.path.endswith("/uploads"):
                return httpx.Response(200, json={"chunkBytes": 262144, "receivedChunks": [], "committed": False})
            if "/chunks/" in request.url.path:
                bodies.append(await request.aread())
                return httpx.Response(401 if len(bodies) == 1 else 200, json={"received": True})
            return httpx.Response(200, json={"committed": True})
        async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as http:
            client = ConnectorIngestClient("http://test", tokens, lambda: http, lambda _: http)
            await client.ingest_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, iter([]), 17)
            assert bodies[0] == bodies[1]
            tokens.assert_any_await(True)
    asyncio.run(run())
