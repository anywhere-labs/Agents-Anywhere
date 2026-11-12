from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from connector.server.errors import ConnectorNetworkError
from connector.server.ingest import ConnectorIngestClient

ITEMS = [{"id": str(index), "orderSeq": index, "content": {"text": "x" * 400}} for index in range(12)]
META = {"externalSessionId": "native", "title": "paged"}


class Uplink(httpx.AsyncBaseTransport):
    """Records every ingest request; ``fail`` maps a page index to responses or exceptions for its attempts."""

    def __init__(self, fail: dict[int, list] | None = None) -> None:
        self.bodies: list[dict] = []
        self.lengths: list[int] = []
        self.fail = {index: list(outcomes) for index, outcomes in (fail or {}).items()}
        self.attempts: list[int] = []
        self.refused: list[int] = []
        self.read_timeouts: list[float] = []

    async def handle_async_request(self, request):
        raw = b"".join([chunk async for chunk in request.stream])
        self.read_timeouts.append(request.extensions["timeout"]["read"])
        page = len(self.bodies)
        self.attempts.append(page)
        outcomes = self.fail.get(page)
        if outcomes:
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            self.refused.append(len(raw))
            return outcome
        self.bodies.append(json.loads(raw))
        self.lengths.append(int(request.headers["Content-Length"]))
        assert self.lengths[-1] == len(raw)
        return httpx.Response(200, json={})


def _run(uplink: Uplink, *, page_bytes: int = 2048, items=ITEMS, progress: list[int] | None = None) -> ConnectorIngestClient:
    client = ConnectorIngestClient(
        "http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http, snapshot_page_bytes=page_bytes,
    )
    http = httpx.AsyncClient(transport=uplink)

    async def on_progress(n: int) -> None:
        if progress is not None:
            progress.append(n)

    async def exercise():
        async with http:
            await client.ingest_snapshot("dsh", "instance", "session", META, iter(items), on_progress=on_progress)

    asyncio.run(exercise())
    return client


def _items(bodies):
    return [item["id"] for body in bodies for item in body["notifications"][-1]["params"]["items"]]


def _replacements(bodies):
    return sum(1 for body in bodies if body["notifications"][-1]["params"]["complete"])


@pytest.fixture(autouse=True)
def _no_backoff(monkeypatch):
    import connector.server.ingest as module

    monkeypatch.setattr(module, "SNAPSHOT_PAGE_RETRY_BACKOFF_SECONDS", 0)


def test_large_snapshot_goes_out_as_a_replacing_page_followed_by_appending_pages():
    uplink, progress = Uplink(), []
    _run(uplink, progress=progress)
    assert len(uplink.bodies) >= 3
    first = uplink.bodies[0]["notifications"]
    assert [n["method"] for n in first] == ["session.meta.upsert", "timeline.sync"]
    assert first[1]["params"]["complete"] is True
    assert all(body["notifications"][0]["params"]["complete"] is False and len(body["notifications"]) == 1 for body in uplink.bodies[1:])
    assert _items(uplink.bodies) == [item["id"] for item in ITEMS]
    assert all(length <= 2048 for length in uplink.lengths)
    assert sum(progress) == sum(uplink.lengths), "progress covers every byte of every page"


def test_small_snapshot_is_still_one_replacing_request():
    uplink = Uplink()
    _run(uplink, page_bytes=1024 * 1024)
    assert len(uplink.bodies) == 1 and uplink.bodies[0]["notifications"][1]["params"]["complete"] is True


def test_default_page_fits_a_history_that_2_1_0_had_to_split():
    from connector.server.snapshot_body import SNAPSHOT_LEGACY_PAGE_BYTES, SNAPSHOT_PAGE_BYTES

    items = [{"id": str(index), "orderSeq": index, "content": {"text": "x" * 1024 * 1024}} for index in range(12)]
    uplink = Uplink()
    _run(uplink, page_bytes=SNAPSHOT_PAGE_BYTES, items=items)
    assert sum(uplink.lengths) > SNAPSHOT_LEGACY_PAGE_BYTES
    assert len(uplink.bodies) == 1, "one atomic replacement instead of a replacing page plus appends"


def test_a_transient_failure_retries_only_that_page_and_never_resends_the_first():
    uplink = Uplink(fail={1: [httpx.ConnectError("reset"), httpx.Response(503)]})
    _run(uplink)
    assert uplink.attempts[:4] == [0, 1, 1, 1]
    assert _replacements(uplink.bodies) == 1
    assert _items(uplink.bodies) == [item["id"] for item in ITEMS]


def test_the_first_page_is_retried_too_before_anything_else_goes_out():
    uplink = Uplink(fail={0: [httpx.ConnectError("reset"), httpx.Response(502)]})
    _run(uplink)
    assert uplink.attempts[:3] == [0, 0, 0]
    assert _replacements(uplink.bodies) == 1 and uplink.bodies[0]["notifications"][1]["params"]["complete"] is True
    assert _items(uplink.bodies) == [item["id"] for item in ITEMS]


def test_exhausted_retries_and_permanent_refusals_stop_the_upload_without_touching_earlier_pages():
    import connector.server.ingest as module

    exhausted = Uplink(fail={2: [httpx.ConnectError("down")] * (module.SNAPSHOT_PAGE_RETRIES + 1)})
    with pytest.raises(ConnectorNetworkError):
        _run(exhausted)
    assert len(exhausted.bodies) == 2 and exhausted.attempts.count(2) == module.SNAPSHOT_PAGE_RETRIES + 1

    refused = Uplink(fail={1: [httpx.Response(400)]})
    with pytest.raises(httpx.HTTPStatusError):
        _run(refused)
    assert len(refused.bodies) == 1 and refused.attempts == [0, 1], "a 4xx is final: no retry, no replay of the first page"

    first = Uplink(fail={0: [httpx.ConnectError("reset")] * (module.SNAPSHOT_PAGE_RETRIES + 1)})
    with pytest.raises(ConnectorNetworkError):
        _run(first)
    assert first.attempts == [0] * (module.SNAPSHOT_PAGE_RETRIES + 1) and first.bodies == []


def test_a_413_halves_the_refused_page_and_repages_what_is_left(monkeypatch):
    import connector.server.ingest as module

    monkeypatch.setattr(module, "SNAPSHOT_MIN_PAGE_BYTES", 512)
    # Refused before anything was replaced: the first page is cut again and still replaces.
    first = Uplink(fail={0: [httpx.Response(413)]})
    client = _run(first, page_bytes=4096)
    (refused,) = first.refused
    assert all(length <= refused // 2 for length in first.lengths)
    assert _replacements(first.bodies) == 1 and first.bodies[0]["notifications"][1]["params"]["complete"] is True
    assert _items(first.bodies) == [item["id"] for item in ITEMS]
    assert client._snapshot_page_bytes == refused // 2, "a proxy limit sticks for later snapshots"

    # Refused after the replacement: only the remaining items are re-paged, as appends.
    items = [{"id": str(index), "orderSeq": index, "content": {"text": "x" * 400}} for index in range(24)]
    later = Uplink(fail={1: [httpx.Response(413), httpx.Response(413)]})
    client = _run(later, page_bytes=4096, items=items)
    assert later.refused[1] <= later.refused[0] // 2, "each cut halves the page that was refused"
    assert _replacements(later.bodies) == 1
    assert all(length <= later.refused[1] // 2 for length in later.lengths[1:])
    assert _items(later.bodies) == [item["id"] for item in items]
    assert client._snapshot_page_bytes == later.refused[1] // 2

    # A page well under the configured size is halved from its own size, not the configured one.
    small = Uplink(fail={0: [httpx.Response(413)]})
    client = _run(small, page_bytes=1024 * 1024, items=ITEMS[:4])
    assert small.refused[0] < 4096 and client._snapshot_page_bytes == small.refused[0] // 2
    assert len(small.bodies) > 1 and _items(small.bodies) == [item["id"] for item in ITEMS[:4]]


def test_a_413_on_a_page_that_cannot_shrink_is_final(monkeypatch):
    import connector.server.ingest as module

    monkeypatch.setattr(module, "SNAPSHOT_MIN_PAGE_BYTES", 1024)
    floor = Uplink(fail={0: [httpx.Response(413)]})
    with pytest.raises(httpx.HTTPStatusError):
        _run(floor, page_bytes=2047)
    assert floor.attempts == [0] and floor.bodies == [] and floor.refused[0] // 2 < 1024

    single = Uplink(fail={0: [httpx.Response(413)]})
    with pytest.raises(httpx.HTTPStatusError):
        _run(single, page_bytes=1024 * 1024, items=ITEMS[:1])
    assert single.attempts == [0]


@pytest.mark.parametrize("drop", [
    httpx.WriteError("broken pipe"), httpx.RemoteProtocolError("Server disconnected without sending a response."),
])
def test_a_large_page_whose_connection_keeps_dropping_is_sent_at_the_legacy_size(monkeypatch, drop):
    import connector.server.ingest as module

    monkeypatch.setattr(module, "SNAPSHOT_LEGACY_PAGE_BYTES", 2048)
    # Some proxies drop an oversized body instead of answering 413.
    dropped = Uplink(fail={0: [drop] * (module.SNAPSHOT_PAGE_RETRIES + 1)})
    client = _run(dropped, page_bytes=8192)
    assert dropped.attempts.count(0) == module.SNAPSHOT_PAGE_RETRIES + 2
    assert all(length <= 2048 for length in dropped.lengths) and len(dropped.bodies) > 1
    assert _replacements(dropped.bodies) == 1
    assert _items(dropped.bodies) == [item["id"] for item in ITEMS]
    assert client._snapshot_page_bytes == 8192, "a dropped connection is no proof of a size limit"


@pytest.mark.parametrize("outage", [httpx.Response(503), httpx.ConnectError("refused"), httpx.ReadTimeout("slow")])
def test_a_server_outage_never_shrinks_the_pages(monkeypatch, outage):
    import connector.server.ingest as module

    monkeypatch.setattr(module, "SNAPSHOT_LEGACY_PAGE_BYTES", 2048)
    down = Uplink(fail={0: [outage] * (module.SNAPSHOT_PAGE_RETRIES + 1)})
    with pytest.raises(ConnectorNetworkError):
        _run(down, page_bytes=8192)
    assert down.attempts == [0] * (module.SNAPSHOT_PAGE_RETRIES + 1) and down.bodies == []


def test_a_page_that_keeps_timing_out_waits_longer_on_each_retry(monkeypatch):
    import connector.server.ingest as module

    monkeypatch.setattr(module, "SNAPSHOT_PAGE_RETRY_BACKOFF_SECONDS", 0)
    # A link slower than the timeout assumes would time out at the same point
    # on every retry; a dropped connection says nothing about the link speed.
    slow = Uplink(fail={0: [httpx.ReadTimeout("slow"), httpx.ConnectError("refused"), httpx.ReadTimeout("slow")]})
    _run(slow, page_bytes=1024 * 1024)
    base = slow.read_timeouts[0]
    assert slow.read_timeouts == [base, base * 2, base * 2, base * 4]
    assert _items(slow.bodies) == [item["id"] for item in ITEMS]


def test_an_unordered_snapshot_neither_waits_for_nor_holds_back_the_shared_queue():
    async def exercise():
        entered, release = asyncio.Event(), asyncio.Event()
        posted: list[str] = []

        async def receive(request):
            body = json.loads(await request.aread())
            methods = [notice["method"] for notice in body["notifications"]]
            if "timeline.sync" in methods:
                entered.set()
                await release.wait()
            posted.append(methods[-1])
            return httpx.Response(200, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(receive)) as http:
            client = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)
            upload = asyncio.create_task(client.ingest_snapshot("dsh", "instance", "session", META, iter(ITEMS), ordered=False))
            await asyncio.wait_for(entered.wait(), 1)
            # Live notifications keep the WebSocket, and other synchronous batches go out at once.
            assert not client.has_pending
            await asyncio.wait_for(client.post_batch([{"method": "session.state.updated", "params": {"sessionId": "other"}}]), 1)
            assert posted == ["session.state.updated"]
            release.set()
            await asyncio.wait_for(upload, 1)
            assert posted == ["session.state.updated", "timeline.sync"]

            # An ordered snapshot still holds the queue until it lands.
            entered.clear()
            release.clear()
            upload = asyncio.create_task(client.ingest_snapshot("acp", "instance", "session", META, iter(ITEMS)))
            await asyncio.wait_for(entered.wait(), 1)
            assert client.has_pending
            batch = asyncio.create_task(client.post_batch([{"method": "session.state.updated", "params": {"sessionId": "other"}}]))
            await asyncio.sleep(0.05)
            assert not batch.done()
            release.set()
            await asyncio.wait_for(asyncio.gather(upload, batch), 1)
            assert posted[-2:] == ["timeline.sync", "session.state.updated"]

    asyncio.run(exercise())
