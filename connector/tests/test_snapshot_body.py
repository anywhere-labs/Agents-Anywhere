import json
import tracemalloc

from connector.server.snapshot_body import body_digest, snapshot_body, snapshot_pages


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
    with snapshot_body("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items), 12) as whole:
        single = whole.read()
    pages = snapshot_pages("dsh", "instance", "session", {"externalSessionId": "native"}, iter(items), through_seq=12)
    try:
        assert len(pages) == 1 and pages[0].read() == single
    finally:
        for page in pages:
            page.close()
