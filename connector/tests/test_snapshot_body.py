import asyncio
import hashlib
import json
import tracemalloc
from unittest.mock import AsyncMock

import httpx

from connector.server.ingest import ConnectorIngestClient
from connector.server.snapshot_body import body_digest, snapshot_body, snapshot_pages


def test_snapshot_encoding_memory_does_not_grow_with_total_history():
    def items():
        for index in range(512):
            yield {"id": str(index), "content": {"text": "中" * 22_000}, "turnId": "private"}

    tracemalloc.start()
    try:
        with snapshot_body("dsh", "instance", "session", {"externalSessionId": "native"}, items()) as body:
            digest, size = body_digest(body)
            _, peak = tracemalloc.get_traced_memory()
            assert size > 32 * 1024 * 1024
            assert peak < 2 * 1024 * 1024
            assert len(digest) == 64
    finally:
        tracemalloc.stop()


def test_snapshot_binding_turn_filtering_and_empty_history():
    for items in ([], [{"id": "one", "metadata": {"turn_id": "private"}, "content": {"text": "你好"}}]):
        with snapshot_body("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items)) as body:
            raw = body.read()
        notices = json.loads(raw)["notifications"]
        assert [n["method"] for n in notices] == ["session.meta.upsert", "timeline.sync"]
        assert all(n["params"]["runtimeId"] == "instance" for n in notices)
        assert notices[1]["params"]["complete"] is True
        assert len(notices[1]["params"]["items"]) == len(items)
        assert b"turn_id" not in raw


def test_snapshot_file_rewinds_for_authentication_retry_and_closes(monkeypatch):
    import connector.server.ingest as module
    original = module.snapshot_pages
    files, hashes = [], []

    def capture(*args, **kwargs):
        result = original(*args, **kwargs)
        files.extend(result)
        return result

    monkeypatch.setattr(module, "snapshot_pages", capture)

    async def run():
        async def receive(request):
            hashes.append(hashlib.sha256(await request.aread()).hexdigest())
            return httpx.Response(401 if len(hashes) == 1 else 200, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as http:
            client = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)
            await client.ingest_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, iter([{"content": {"text": "x" * 200_000}}]))
        assert hashes[0] == hashes[1]
        assert files[0].closed

    asyncio.run(run())


def test_snapshot_pages_split_at_item_boundaries_and_rebuild_the_same_timeline():
    items = [{"id": str(index), "orderSeq": index, "content": {"text": "中" * 300}} for index in range(40)]
    pages = snapshot_pages("dsh", "instance", "session", {"externalSessionId": "native", "title": "t"}, iter(items), page_bytes=4096)
    try:
        assert len(pages) > 3
        decoded = [json.loads(page.read()) for page in pages]
    finally:
        for page in pages:
            page.close()
    first = decoded[0]["notifications"]
    assert [n["method"] for n in first] == ["session.meta.upsert", "timeline.sync"]
    assert first[1]["params"]["complete"] is True
    for later in decoded[1:]:
        (sync,) = later["notifications"]
        assert sync["method"] == "timeline.sync" and sync["params"]["complete"] is False
        assert sync["params"]["sessionId"] == "session" and sync["params"]["externalSessionId"] == "native"
        assert sync["params"]["runtimeId"] == "instance"
        assert sync["params"]["items"], "a later page always carries items"
    merged = [item for page in decoded for item in page["notifications"][-1]["params"]["items"]]
    assert [item["id"] for item in merged] == [item["id"] for item in items]
    assert [item["orderSeq"] for item in merged] == sorted(item["orderSeq"] for item in merged)
    sizes = []
    pages = snapshot_pages("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items), page_bytes=4096)
    try:
        for page in pages:
            page.seek(0, 2)
            sizes.append(page.tell())
    finally:
        for page in pages:
            page.close()
    assert all(size <= 4096 for size in sizes[1:-1]), "middle pages stay within the limit"


def test_single_page_body_is_the_unpaged_snapshot():
    items = [{"id": "a", "content": {"text": "x"}}, {"id": "b", "content": {"text": "y"}}]
    with snapshot_body("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items)) as whole:
        single = whole.read()
    pages = snapshot_pages("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items))
    try:
        assert len(pages) == 1 and pages[0].read() == single
    finally:
        for page in pages:
            page.close()
