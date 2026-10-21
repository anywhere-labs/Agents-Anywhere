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

    async def handle_async_request(self, request):
        raw = b"".join([chunk async for chunk in request.stream])
        page = len(self.bodies)
        self.attempts.append(page)
        outcomes = self.fail.get(page)
        if outcomes:
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        self.bodies.append(json.loads(raw))
        self.lengths.append(int(request.headers["Content-Length"]))
        assert self.lengths[-1] == len(raw)
        return httpx.Response(200, json={})


def _run(uplink: Uplink, *, page_bytes: int = 2048):
    progress: list[int] = []

    async def exercise():
        async with httpx.AsyncClient(transport=uplink) as http:
            client = ConnectorIngestClient("http://test", AsyncMock(return_value="token"), lambda: http, lambda _: http, snapshot_page_bytes=page_bytes)

            async def on_progress(n: int) -> None:
                progress.append(n)

            await client.ingest_snapshot("dsh", "instance", "session", META, iter(ITEMS), on_progress=on_progress)

    asyncio.run(exercise())
    return progress


def _items(bodies):
    return [item["id"] for body in bodies for item in body["notifications"][-1]["params"]["items"]]


def test_large_snapshot_goes_out_as_a_replacing_page_followed_by_appending_pages():
    uplink = Uplink()
    progress = _run(uplink)
    assert len(uplink.bodies) >= 3
    first = uplink.bodies[0]["notifications"]
    assert [n["method"] for n in first] == ["session.meta.upsert", "timeline.sync"]
    assert first[1]["params"]["complete"] is True
    assert all(body["notifications"][0]["params"]["complete"] is False and len(body["notifications"]) == 1 for body in uplink.bodies[1:])
    assert _items(uplink.bodies) == [item["id"] for item in ITEMS]
    assert sum(progress) == sum(uplink.lengths), "progress covers every byte of every page"


def test_small_snapshot_is_still_one_replacing_request():
    uplink = Uplink()
    _run(uplink, page_bytes=1024 * 1024)
    assert len(uplink.bodies) == 1 and uplink.bodies[0]["notifications"][1]["params"]["complete"] is True


def test_a_transient_failure_retries_only_that_page_and_never_resends_the_first(monkeypatch):
    import connector.server.ingest as module

    monkeypatch.setattr(module, "SNAPSHOT_PAGE_RETRY_BACKOFF_SECONDS", 0)
    uplink = Uplink(fail={1: [httpx.ConnectError("reset"), httpx.Response(503)]})
    _run(uplink)
    assert uplink.attempts[:4] == [0, 1, 1, 1]
    assert sum(1 for body in uplink.bodies if body["notifications"][-1]["params"]["complete"]) == 1
    assert _items(uplink.bodies) == [item["id"] for item in ITEMS]


def test_exhausted_retries_and_permanent_refusals_stop_the_upload_without_touching_earlier_pages(monkeypatch):
    import connector.server.ingest as module

    monkeypatch.setattr(module, "SNAPSHOT_PAGE_RETRY_BACKOFF_SECONDS", 0)
    exhausted = Uplink(fail={2: [httpx.ConnectError("down")] * (module.SNAPSHOT_PAGE_RETRIES + 1)})
    with pytest.raises(ConnectorNetworkError):
        _run(exhausted)
    assert len(exhausted.bodies) == 2 and exhausted.attempts.count(2) == module.SNAPSHOT_PAGE_RETRIES + 1

    refused = Uplink(fail={1: [httpx.Response(413)]})
    with pytest.raises(httpx.HTTPStatusError):
        _run(refused)
    assert len(refused.bodies) == 1 and refused.attempts == [0, 1], "a 4xx is final: no retry, no replay of the first page"

    # Nothing has been replaced yet when the first page fails: surface it at once, as a
    # single-request snapshot always did, and let the subscription recalibrate.
    first = Uplink(fail={0: [httpx.ConnectError("reset")]})
    with pytest.raises(ConnectorNetworkError):
        _run(first)
    assert first.attempts == [0] and first.bodies == []
