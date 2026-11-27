from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import AsyncMock

import httpx
import pytest

from connector.server.errors import ConnectorNetworkError
from connector.server.ingest import ConnectorIngestClient, ConnectorIngestDeferredError

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
    from connector.server.snapshot_body import (
        SNAPSHOT_LEGACY_PAGE_BYTES,
        SNAPSHOT_PAGE_BYTES,
    )

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


def _upload(client: ConnectorIngestClient, session: str = "session", **options) -> None:
    return client.ingest_snapshot("dsh", "instance", session, META, iter(ITEMS), **options)


def test_a_page_whose_body_stalls_is_given_up_at_once():
    import connector.server.ingest as module

    # No progress for the whole write timeout: the path cannot carry bulk
    # traffic now. Sent again, the page only keeps the path busy.
    stalled = Uplink(fail={1: [httpx.WriteTimeout("stalled")] * (module.SNAPSHOT_PAGE_RETRIES + 1)})
    with pytest.raises(ConnectorNetworkError) as raised:
        _run(stalled)
    assert stalled.attempts == [0, 1], "sent once: not again at the same size, not re-paged"
    assert isinstance(raised.value.__cause__, httpx.WriteTimeout)
    assert len(stalled.bodies) == 1, "the first page was accepted and is never sent again"


def test_an_oversized_page_that_stalls_is_not_cut_to_the_legacy_size(monkeypatch):
    import connector.server.ingest as module

    monkeypatch.setattr(module, "SNAPSHOT_LEGACY_PAGE_BYTES", 1024)
    # A stalled body says nothing about the page's size, whatever the size.
    stalled = Uplink(fail={0: [httpx.WriteTimeout("stalled")]})
    with pytest.raises(ConnectorNetworkError):
        _run(stalled, page_bytes=4096)
    assert stalled.attempts == [0] and stalled.bodies == []


@pytest.mark.parametrize("ordered", [True, False])
def test_a_stalled_upload_makes_the_next_snapshots_wait_without_touching_the_path(ordered):
    import connector.server.ingest as module

    wait = module.SNAPSHOT_STALL_WAIT_SECONDS
    stalled = Uplink(fail={0: [httpx.WriteTimeout("stalled")]})
    http = httpx.AsyncClient(transport=stalled)
    client = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)

    async def exercise():
        async with http:
            with pytest.raises(ConnectorNetworkError):
                await _upload(client, ordered=ordered)
            for session in ("one", "another"):
                with pytest.raises(ConnectorIngestDeferredError) as deferred:
                    await _upload(client, session, ordered=ordered)
                assert f"deferred for {wait:.0f}s" in str(deferred.value)
                assert deferred.value.retry_in == pytest.approx(wait, abs=5), "the caller is told how long to wait"
                assert isinstance(deferred.value, ConnectorNetworkError), "and it is still an outage for a caller that does not look"
            # Live notifications are not bulk traffic: they still go out.
            await client.post_batch([{"method": "session.state.updated", "params": {"sessionId": "one"}}])

    asyncio.run(exercise())
    assert len(stalled.attempts) == 2, "one stalled page, one live batch: nothing was sent while uploads waited"
    assert [notice["method"] for body in stalled.bodies for notice in body["notifications"]] == ["session.state.updated"]
    assert client._snapshot_stalls == 1


def test_the_wait_doubles_with_each_stalled_upload_and_ends_after_one_gets_through(monkeypatch):
    import connector.server.ingest as module

    waits = (0.05, 0.1, 0.2)
    monkeypatch.setattr(module, "SNAPSHOT_STALL_WAIT_SECONDS", waits[0])
    monkeypatch.setattr(module, "SNAPSHOT_STALL_WAIT_MAX_SECONDS", waits[-1])
    stalled = Uplink(fail={0: [httpx.WriteTimeout("stalled")] * (len(waits) + 1)})
    http = httpx.AsyncClient(transport=stalled)
    client = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)

    async def exercise():
        async with http:
            for wait in (*waits, waits[-1]):
                with pytest.raises(ConnectorNetworkError):
                    await _upload(client)
                remaining = client._snapshot_retry_at - time.monotonic()
                # Doubled, not merely non-zero: a constant wait of half the base must not pass.
                assert wait / 2 < remaining <= wait, f"expected a wait of about {wait}s, got {remaining}"
                await asyncio.sleep(wait + 0.01)
            # The path came back: this one gets through and the count starts over.
            await _upload(client)

    asyncio.run(exercise())
    assert stalled.attempts.count(0) == len(waits) + 2
    assert _items(stalled.bodies) == [item["id"] for item in ITEMS] and client._snapshot_stalls == 0

class Switchable(Uplink):
    """Stalls every page while `stall` is set; passes everything once it is not."""

    def __init__(self) -> None:
        super().__init__()
        self.stall = True

    async def handle_async_request(self, request):
        if self.stall:
            self.attempts.append(len(self.bodies))
            raise httpx.WriteTimeout("stalled")
        return await super().handle_async_request(request)


def _over(path) -> tuple[httpx.AsyncClient, ConnectorIngestClient]:
    http = httpx.AsyncClient(transport=path)
    return http, ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)


def test_a_stalled_upload_cools_down_for_one_minute():
    import connector.server.ingest as module

    # A stall says the path is weak right now, not for the next ten minutes (seen on a weak
    # link: 19 of 20 snapshots were refused unsent behind one stalled page). A minute keeps the
    # page from being sent again at once; ten minutes starved every other session.
    assert (module.SNAPSHOT_STALL_WAIT_SECONDS, module.SNAPSHOT_STALL_WAIT_MAX_SECONDS) == (60.0, 600.0)
    http, client = _over(Switchable())

    async def exercise():
        async with http:
            with pytest.raises(ConnectorIngestDeferredError) as stalled:
                await _upload(client)
            assert stalled.value.stalled is True, "its own page stalled: told apart from a refusal unsent"
            assert isinstance(stalled.value.__cause__, httpx.WriteTimeout)
            assert "deferred for 60s" in str(stalled.value)
            assert client.snapshot_wait() == pytest.approx(60, abs=1)

    asyncio.run(exercise())


@pytest.mark.parametrize("ordered", [True, False])
def test_only_the_upload_whose_body_stalled_is_told_so(ordered):
    path = Switchable()
    http, client = _over(path)

    async def exercise():
        async with http:
            with pytest.raises(ConnectorIngestDeferredError) as own:
                await _upload(client, "own", ordered=ordered)
            assert own.value.stalled is True, "its page was too much for the path: a caller that knows the page may wait longer"
            for session in ("another", "third"):
                with pytest.raises(ConnectorIngestDeferredError) as refused:
                    await _upload(client, session, ordered=ordered)
                assert refused.value.stalled is False, "nothing of it was sent: only the path's cool-down holds it"
                assert refused.value.__cause__ is None
            assert path.attempts == [0]

    asyncio.run(exercise())


def test_each_further_stall_with_nothing_getting_through_doubles_the_cool_down_up_to_ten_minutes():
    import connector.server.ingest as module

    http, client = _over(Switchable())

    async def exercise():
        async with http:
            for stalls, cool_down in enumerate((60, 120, 240, 480, 600, 600, 600), start=1):
                if stalls > 1:
                    client._snapshot_retry_at = time.monotonic() - 1  # the cool-down ran its course, nothing got through in it
                with pytest.raises(ConnectorIngestDeferredError):
                    await _upload(client)
                left = client.snapshot_wait()
                assert cool_down - 1 < left <= cool_down, f"stall {stalls}: a cool-down of {cool_down}s was due, {left:.0f}s was set"

    asyncio.run(exercise())
    assert client._snapshot_stalls == 7 and client.snapshot_wait() == pytest.approx(600, abs=1)
    assert module._snapshot_stall_wait(1000) == module.SNAPSHOT_STALL_WAIT_MAX_SECONDS == 600.0, "the cap holds for any count"


def test_an_upload_that_gets_through_starts_the_cool_down_over():
    path = Switchable()
    http, client = _over(path)

    async def exercise():
        async with http:
            for stalls in (1, 2, 3, 4):
                if stalls > 1:
                    client._snapshot_retry_at = time.monotonic() - 1  # the cool-down ran out
                with pytest.raises(ConnectorIngestDeferredError):
                    await _upload(client)
            assert client._snapshot_stalls == 4 and 479 < client.snapshot_wait() <= 480
            # The cool-down ran out and the path came back: this one gets through.
            client._snapshot_retry_at = time.monotonic() - 1
            path.stall = False
            await _upload(client)
            assert client.snapshot_wait() == 0.0 and client._snapshot_stalls == 0
            # The next stall starts over: a minute, not the eight minutes after four stalls.
            path.stall = True
            with pytest.raises(ConnectorIngestDeferredError):
                await _upload(client)
            assert client.snapshot_wait() == pytest.approx(60, abs=1), "counted from the upload that got through"

    asyncio.run(exercise())
    assert _items(path.bodies) == [item["id"] for item in ITEMS]


@pytest.mark.parametrize("outage", [httpx.Response(503), httpx.ConnectError("refused"), httpx.ReadTimeout("slow")])
def test_an_outage_or_a_slow_answer_never_makes_snapshots_wait(outage):
    import connector.server.ingest as module

    # A Server that is down, slow or answering 5xx is not a path too slow to carry the page.
    down = Uplink(fail={0: [outage] * (module.SNAPSHOT_PAGE_RETRIES + 1)})
    http = httpx.AsyncClient(transport=down)
    client = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)

    async def exercise():
        async with http:
            with pytest.raises(ConnectorNetworkError):
                await _upload(client)

    asyncio.run(exercise())
    assert down.attempts == [0] * (module.SNAPSHOT_PAGE_RETRIES + 1)
    assert client._snapshot_stalls == 0 and client._snapshot_retry_at == 0.0

    slow_answer = Uplink(fail={0: [httpx.ReadTimeout("slow")]})
    client = _run(slow_answer, page_bytes=1024 * 1024)
    assert len(slow_answer.bodies) == 1 and client._snapshot_stalls == 0, "a slow answer is waited for, not given up"


class Held(Uplink):
    """Holds every request until release is set, so that uploads are admitted and in flight together."""

    def __init__(self, fail: dict[int, list] | None = None) -> None:
        super().__init__(fail)
        self.arrived = 0
        self.release = asyncio.Event()

    async def handle_async_request(self, request):
        self.arrived += 1
        await self.release.wait()
        return await super().handle_async_request(request)


async def _in_flight(transport: Held, count: int) -> None:
    for _ in range(400):
        if transport.arrived >= count:
            break
        await asyncio.sleep(0.005)
    assert transport.arrived == count, f"expected {count} request(s) waiting on the path, saw {transport.arrived}"


def test_stalls_while_a_wait_is_on_are_one_wait():
    import connector.server.ingest as module

    # Two uploads admitted together both stall: one slow path, not two.
    stalled = Held(fail={0: [httpx.WriteTimeout("stalled")] * 2})
    http = httpx.AsyncClient(transport=stalled)
    client = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)

    async def exercise():
        async with http:
            pending = [asyncio.ensure_future(_upload(client, name, ordered=False)) for name in ("one", "another")]
            await _in_flight(stalled, 2)
            stalled.release.set()
            results = await asyncio.gather(*pending, return_exceptions=True)
            assert [isinstance(result, ConnectorIngestDeferredError) for result in results] == [True, True]
            with pytest.raises(ConnectorIngestDeferredError) as deferred:
                await _upload(client, "third")
            assert deferred.value.retry_in <= module.SNAPSHOT_STALL_WAIT_SECONDS, "the second stall did not double the wait"

    asyncio.run(exercise())
    assert stalled.attempts == [0, 0] and client._snapshot_stalls == 1


def test_an_ordered_upload_that_queued_for_the_lock_is_deferred_once_it_holds_it():
    stalled = Uplink(fail={0: [httpx.WriteTimeout("stalled")]})
    http = httpx.AsyncClient(transport=stalled)
    client = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)

    async def exercise():
        async with http:
            await client._post_lock.acquire()
            # Admitted while nothing waited, then held at the lock behind another upload.
            queued = asyncio.ensure_future(_upload(client, "queued"))
            await asyncio.sleep(0.05)
            assert not queued.done() and stalled.attempts == [], "held at the lock: nothing sent yet"
            with pytest.raises(ConnectorNetworkError):
                await _upload(client, "stalled", ordered=False)
            client._post_lock.release()
            with pytest.raises(ConnectorIngestDeferredError) as deferred:
                await queued
            assert deferred.value.stalled is False, "nothing of it was sent: only the path's cool-down holds it"

    asyncio.run(exercise())
    assert stalled.attempts == [0], "the queued upload sent nothing during the wait"


def test_an_upload_admitted_earlier_that_gets_through_ends_the_wait():
    import connector.server.ingest as module

    # The first upload stalls; the second was admitted before that and gets through.
    held = Held(fail={0: [httpx.WriteTimeout("stalled")]})
    http = httpx.AsyncClient(transport=held)
    client = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)

    async def exercise():
        async with http:
            stalling = asyncio.ensure_future(_upload(client, "stalling", ordered=False))
            await _in_flight(held, 1)
            through = asyncio.ensure_future(_upload(client, "through", ordered=False))
            await _in_flight(held, 2)
            held.release.set()
            with pytest.raises(ConnectorIngestDeferredError) as stalled:
                await stalling
            assert stalled.value.retry_in == pytest.approx(module.SNAPSHOT_STALL_WAIT_SECONDS, abs=5), "the upload that found the stall is told the wait too"
            assert stalled.value.stalled is True, "and that the stall was its own"
            await through
            assert client._snapshot_stalls == 0 and client.snapshot_wait() == 0.0
            await _upload(client, "after")

    asyncio.run(exercise())
    assert len(held.bodies) == 2 and _items(held.bodies) == [item["id"] for item in ITEMS] * 2


def test_a_batch_that_stalls_ahead_of_an_ordered_snapshot_also_makes_snapshots_wait(monkeypatch):
    import connector.server.ingest as module

    monkeypatch.setattr(module, "SYNC_BATCH_RETRY_BACKOFF_SECONDS", 0)
    # A notification batch of 64 KiB chunks that the path cannot take says as much about
    # bulk traffic as a page does. The snapshot itself is not sent.
    stalled = Held(fail={0: [httpx.WriteTimeout("stalled")] * (module.SYNC_BATCH_RETRIES + 1)})
    http = httpx.AsyncClient(transport=stalled)
    client = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http)

    async def exercise():
        async with http:
            await client.enqueue("session.state.updated", {"sessionId": "one"})
            pending = asyncio.ensure_future(_upload(client, "snapshot"))
            await _in_flight(stalled, 1)
            stalled.release.set()
            with pytest.raises(ConnectorNetworkError) as raised:
                await pending
            assert isinstance(raised.value.__cause__, httpx.WriteTimeout)
            with pytest.raises(ConnectorIngestDeferredError):
                await _upload(client, "later")

    asyncio.run(exercise())
    assert stalled.attempts == [0] * (module.SYNC_BATCH_RETRIES + 1) and stalled.bodies == []
    assert client._snapshot_stalls == 1, "the batch's stalls made snapshots wait"
