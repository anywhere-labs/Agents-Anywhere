import asyncio
import hashlib
import json
import tracemalloc
from unittest.mock import AsyncMock

import httpx

from connector.server.ingest import ConnectorIngestClient
from connector.server.snapshot_body import body_digest, snapshot_body


def test_snapshot_encoding_memory_does_not_grow_with_total_history():
    def items():
        for index in range(512):
            yield {"id": str(index), "content": {"text": "中" * 22_000}, "turnId": "private"}

    tracemalloc.start()
    try:
        with snapshot_body("dsh", "instance", "session", {"externalSessionId": "native"}, items(), 12) as body:
            digest, size = body_digest(body)
            _, peak = tracemalloc.get_traced_memory()
            assert size > 32 * 1024 * 1024
            assert peak < 2 * 1024 * 1024
            assert len(digest) == 64
    finally:
        tracemalloc.stop()


def test_snapshot_binding_turn_filtering_and_empty_history():
    for items in ([], [{"id": "one", "metadata": {"turn_id": "private"}, "content": {"text": "你好"}}]):
        with snapshot_body("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items), 12) as body:
            raw = body.read()
        notices = json.loads(raw)["notifications"]
        assert [n["method"] for n in notices] == ["session.meta.upsert", "timeline.sync"]
        assert all(n["params"]["runtimeId"] == "instance" for n in notices)
        assert notices[1]["params"]["complete"] is True
        assert len(notices[1]["params"]["items"]) == len(items)
        assert b"turn_id" not in raw


def test_snapshot_file_rewinds_for_authentication_retry_and_closes(monkeypatch):
    import connector.server.ingest as module
    original = module.snapshot_body
    files, hashes = [], []

    def capture(*args):
        result = original(*args)
        files.append(result)
        return result

    monkeypatch.setattr(module, "snapshot_body", capture)

    async def run():
        async def receive(request):
            if request.url.path.endswith("/uploads"):
                return httpx.Response(200, json={"chunkBytes": 262144, "receivedChunks": [], "committed": False})
            if request.url.path.endswith("/commit"):
                return httpx.Response(200, json={"committed": True})
            hashes.append(hashlib.sha256(await request.aread()).hexdigest())
            return httpx.Response(401 if len(hashes) == 1 else 200, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as http:
            client = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)
            await client.ingest_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, iter([{"content": {"text": "x" * 200_000}}]), 12)
        assert hashes[0] == hashes[1]
        assert files[0].closed

    asyncio.run(run())


def test_observation_clock_does_not_change_snapshot_resume_identity():
    hashes = []
    for observed in ("2026-10-02T00:00:00Z", "2026-10-02T01:00:00Z"):
        meta = {"externalSessionId": "native", "sourceState": {"availability": "available", "reason": None, "observedAt": observed}}
        with snapshot_body("dsh", "instance", "session", meta, iter([]), 12) as body:
            hashes.append(body_digest(body)[0])
    assert hashes[0] == hashes[1]
