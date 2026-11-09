import asyncio
import hashlib
import itertools
import json
import tracemalloc
from unittest.mock import AsyncMock

import httpx

from connector.server.ingest import ConnectorIngestClient
from connector.server.snapshot_body import (
    EncodedSnapshot,
    body_digest,
    encode_snapshot,
    snapshot_body,
)


def page_bodies(snapshot: EncodedSnapshot, page_bytes: int | None, *, start: int = 0, first: bool = True) -> list[bytes]:
    """Every request body the uploader cuts from ``start`` at this page size."""
    bodies = []
    while first or start < len(snapshot):
        end = snapshot.page_end(start, page_bytes, first=first)
        body = b"".join(snapshot.page_chunks(start, end, first=first, chunk_bytes=1000))
        assert len(body) == snapshot.page_size(start, end, first=first)
        bodies.append(body)
        start, first = end, False
    return bodies


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
    original = module.encode_snapshot
    files, hashes = [], []

    def capture(*args, **kwargs):
        result = original(*args, **kwargs)
        files.append(result)
        return result

    monkeypatch.setattr(module, "encode_snapshot", capture)

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
    with encode_snapshot("dsh", "instance", "session", {"externalSessionId": "native", "title": "t"}, iter(items)) as snapshot:
        bodies = page_bodies(snapshot, 4096)
    assert len(bodies) > 3
    assert all(len(body) <= 4096 for body in bodies), "every page stays within the limit"
    decoded = [json.loads(body) for body in bodies]
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


def test_remaining_items_are_recut_at_another_page_size_without_encoding_again():
    items = [{"id": str(index), "orderSeq": index, "content": {"text": "x" * 500}} for index in range(30)]
    with encode_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items)) as snapshot:
        assert len(snapshot) == 30
        coarse = page_bodies(snapshot, 8192)
        start = len(json.loads(coarse[0])["notifications"][-1]["params"]["items"])
        # The first page was accepted; the rest goes out in smaller appending pages.
        fine = page_bodies(snapshot, 2048, start=start, first=False)
    assert len(fine) > len(coarse) - 1
    later = [json.loads(body)["notifications"] for body in fine]
    assert all(len(notices) == 1 and notices[0]["params"]["complete"] is False for notices in later)
    ids = [item["id"] for notices in [json.loads(coarse[0])["notifications"], *later] for item in notices[-1]["params"]["items"]]
    assert ids == [item["id"] for item in items]


def test_an_item_larger_than_the_page_still_goes_out_alone():
    items = [{"id": "big", "content": {"text": "x" * 5000}}, {"id": "small", "content": {"text": "y"}}]
    with encode_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items)) as snapshot:
        assert snapshot.page_end(0, 1024, first=True) == 1
        assert snapshot.page_end(1, 1024, first=False) == 2
        assert snapshot.page_end(0, None, first=True) == 2


def test_single_page_body_is_the_unpaged_snapshot():
    items = [{"id": "a", "content": {"text": "x"}}, {"id": "b", "content": {"text": "y"}}]
    with snapshot_body("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items)) as whole:
        single = whole.read()
    with encode_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items)) as snapshot:
        assert page_bodies(snapshot, 45 * 1024 * 1024) == [single]
    assert json.loads(single)["notifications"][1]["params"]["items"] == items


def _sync_params(body: bytes) -> dict:
    return json.loads(body)["notifications"][-1]["params"]


def test_paged_snapshot_pages_tile_the_order_seq_space_with_ranges():
    items = [{"id": str(index), "orderSeq": index * 10, "content": {"text": "中" * 300}} for index in range(40)]
    with encode_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items)) as snapshot:
        bodies = page_bodies(snapshot, 4096)
    assert len(bodies) > 3
    assert all(len(body) <= 4096 for body in bodies)
    pages = [_sync_params(body) for body in bodies]
    ranges = [page["snapshotRange"] for page in pages]
    assert "afterOrderSeq" not in ranges[0], "the first page is unbounded below"
    assert "throughOrderSeq" not in ranges[-1], "the last page is unbounded above"
    for previous, current in itertools.pairwise(ranges):
        assert current["afterOrderSeq"] == previous["throughOrderSeq"], "pages leave no gap"
    for page in pages:
        bounds = page["snapshotRange"]
        for item in page["items"]:
            assert bounds.get("afterOrderSeq", -(2**31)) < item["orderSeq"] <= bounds.get("throughOrderSeq", 2**31)
    assert [page["complete"] for page in pages] == [True] + [False] * (len(pages) - 1)


def test_ranges_follow_the_highest_order_seq_when_items_are_out_of_order():
    order = [0, 1, 2, 9, 3, 4, 5, 6, 7, 8]
    items = [{"id": str(seq), "orderSeq": seq, "content": {"text": "x" * 300}} for seq in order]
    with encode_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items)) as snapshot:
        pages = [_sync_params(body) for body in page_bodies(snapshot, 800)]
    assert len(pages) > 2
    for previous, current in itertools.pairwise(pages):
        after, through = current["snapshotRange"].get("afterOrderSeq"), current["snapshotRange"].get("throughOrderSeq")
        assert after == previous["snapshotRange"]["throughOrderSeq"]
        assert through is None or after <= through, "an out-of-order page never names an inverted range"


def test_a_recut_page_after_the_first_names_its_own_range():
    items = [{"id": str(index), "orderSeq": index, "content": {"text": "x" * 500}} for index in range(30)]
    with encode_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items)) as snapshot:
        start = snapshot.page_end(0, 8192, first=True)
        fine = page_bodies(snapshot, 2048, start=start, first=False)
    assert _sync_params(fine[0])["snapshotRange"]["afterOrderSeq"] == start - 1
    assert "throughOrderSeq" not in _sync_params(fine[-1])["snapshotRange"]


def test_single_page_and_order_less_snapshots_carry_no_range():
    ordered = [{"id": str(index), "orderSeq": index, "content": {"text": "x"}} for index in range(3)]
    with encode_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, iter(ordered)) as snapshot:
        (single,) = page_bodies(snapshot, 45 * 1024 * 1024)
    assert "snapshotRange" not in _sync_params(single)
    unordered = [{"id": str(index), "content": {"text": "x" * 500}} for index in range(10)]
    with encode_snapshot("dsh", "instance", "session", {"externalSessionId": "native"}, iter(unordered)) as snapshot:
        bodies = page_bodies(snapshot, 1024)
    assert len(bodies) > 1
    assert all("snapshotRange" not in _sync_params(body) for body in bodies)
