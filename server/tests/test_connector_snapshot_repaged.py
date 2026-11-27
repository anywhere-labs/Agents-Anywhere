"""A snapshot the Connector had to re-page on the way lands like one that went out as planned.

The Connector cuts a page whose body stalled, or one the Server answered 401 after a body that
outlived its access token, and continues the capture from that page with smaller pages; it never
sends an accepted page again. Against the real ingest route this pins what that rests on: the route
reads the whole body before it looks at the token, a re-paged capture rebuilds the same timeline as
one that was not, and a re-paged capture of an unchanged timeline writes no row.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
import starlette.requests
from connector.server import ingest as ingest_module
from connector.server.ingest import ConnectorIngestClient
from test_backend_mvp import create_connector_and_session, make_client
from test_timeline_paged_snapshot import _ingest, _item, _timeline

import agent_server.api.connector_ingress as ingest_route

ITEMS = 48
PAGE_BYTES = 8192
LARGE = 6000  # bytes: above any page cut once from PAGE_BYTES


class _Attempt:
    """One page as the Connector sent it."""

    def __init__(self, page: int, attempt: int, request: httpx.Request) -> None:
        self.page, self.attempt, self.size = page, attempt, len(request.content)
        notifications = json.loads(request.content)["notifications"]
        sync = next((n["params"] for n in notifications if n["method"] == "timeline.sync"), {})
        self.range = sync.get("snapshotRange")
        self.complete = bool(sync.get("complete"))
        self.opens_capture = any(n["method"] == "session.meta.upsert" for n in notifications)


class _Path(httpx.AsyncBaseTransport):
    """The real app behind a transport where some attempts of page `fail_page` do not land.

    A page is named by how many pages landed before it; an attempt by how many times that page was
    sent before. `fail` is called with both and the body's size; it returns a response to answer
    instead of the app's, or raises. Every attempt is recorded with what the Connector was given.
    """

    def __init__(self, app, fail_page: int, fail) -> None:
        self.app = httpx.ASGITransport(app=app)
        self.fail_page, self.fail = fail_page, fail
        self.landed = 0
        self.attempts: list[_Attempt] = []
        self.statuses: list[int | str] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        await request.aread()  # the Connector streams the page; read it to know it
        page = self.landed
        attempt = _Attempt(page, sum(1 for sent in self.attempts if sent.page == page), request)
        self.attempts.append(attempt)
        try:
            answered = self.fail(page, attempt.attempt, attempt.size)
        except httpx.HTTPError as exc:
            self.statuses.append(type(exc).__name__)
            raise
        if answered is not None:
            self.statuses.append(answered.status_code)
            return answered
        response = await self.app.handle_async_request(request)
        self.statuses.append(response.status_code)
        self.landed += 1
        return response

    def landed_pages(self) -> list[_Attempt]:
        return [sent for sent, status in zip(self.attempts, self.statuses) if status == 200]


class _Tokens:
    """The real access token, except for one call."""

    def __init__(self, good: str, bad: str, bad_call: int) -> None:
        self.good, self.bad, self.bad_call = good, bad, bad_call
        self.calls = 0

    async def __call__(self, force: bool = False) -> str:
        self.calls += 1
        return self.bad if self.calls - 1 == self.bad_call else self.good


def _upload(app, access_token: str, session_id: str, path: _Path, *, bad_call: int = -1) -> None:
    http = httpx.AsyncClient(transport=path)
    # The same connector id with a signature the Server refuses: a token that no longer gets in.
    bad = access_token.rsplit(".", 1)[0] + ".nosig"
    client = ConnectorIngestClient(
        "http://test", _Tokens(access_token, bad, bad_call), lambda: http, lambda _: http, snapshot_page_bytes=PAGE_BYTES,
    )

    async def exercise():
        async with http:
            await client.ingest_snapshot(
                "dsh", "dsh", session_id, {"externalSessionId": "native", "title": "re-paged"},  # the instance id is the runtime type
                iter(_item(session_id, index, "x" * 400) for index in range(ITEMS)),
            )

    asyncio.run(exercise())


def _walks_the_timeline_once(path: _Path) -> bool:
    """Every page that landed starts where the one before it ended, and no range was sent twice."""
    landed = path.landed_pages()
    # The first page's range ends at a sequence number and has no start; the last page's is the other way round.
    ranges = [(page.range.get("afterOrderSeq"), page.range.get("throughOrderSeq")) for page in landed]
    return [start for start, _ in ranges[1:]] == [end for _, end in ranges[:-1]] and len(set(ranges)) == len(ranges)


@pytest.fixture
def rows_touched(monkeypatch):
    """Record the rows every timeline write touches (as the paged-snapshot tests do)."""

    def install(client) -> dict[str, list]:
        timeline = client.app.state.store.timeline
        seen: dict[str, list] = {"written": [], "deleted": []}
        upsert_many, delete_items = timeline.upsert_many, timeline.delete_items

        async def spy_upsert_many(conn, items):
            seen["written"].extend(item.id for item in items)
            return await upsert_many(conn, items)

        async def spy_delete_items(conn, session_id, item_ids):
            seen["deleted"].extend(item_ids)
            return await delete_items(conn, session_id, item_ids)

        monkeypatch.setattr(timeline, "upsert_many", spy_upsert_many)
        monkeypatch.setattr(timeline, "delete_items", spy_delete_items)
        return seen

    return install


def test_the_ingest_route_reads_the_whole_body_before_it_looks_at_the_token(tmp_path, monkeypatch):
    client = make_client(tmp_path)
    _, _, session_id, _ = create_connector_and_session(client, runtime="dsh")
    order: list[tuple[str, int | None]] = []
    read_body = starlette.requests.Request.body
    admit = ingest_route._access_token_connector_id

    async def spy_body(self):
        body = await read_body(self)
        order.append(("body", len(body)))
        return body

    def spy_admission(authorization):
        order.append(("token", None))
        return admit(authorization)

    monkeypatch.setattr(starlette.requests.Request, "body", spy_body)
    monkeypatch.setattr(ingest_route, "_access_token_connector_id", spy_admission)
    headers = {"Authorization": "Bearer not-a-token", "Content-Type": "application/json"}
    valid = json.dumps({"notifications": [{"method": "timeline.sync", "params": {
        "sessionId": session_id, "externalSessionId": "native", "items": [], "complete": True,
    }}]}).encode()
    body = valid + b" " * 4096

    response = client.post("/connector/ingest", headers=headers, content=body)

    assert response.status_code == 401, response.text
    # The framework reads the body before anything else (twice: the raw bytes, then the parsed JSON).
    assert order[-1] == ("token", None), "the token is refused last"
    assert {size for kind, size in order if kind == "body"} == {len(body)} and order[0][0] == "body", "the whole body is read first"

    # A body that does not validate is refused before the token is looked at at all.
    order.clear()
    response = client.post("/connector/ingest", headers=headers, content=b'{"notifications": []}')
    assert response.status_code == 422 and {size for _, size in order} == {21}, "the body is parsed first"
    assert "token" not in [kind for kind, _ in order], "and the token is not looked at at all"


def _stall(page: int, attempt: int, size: int):
    if page == 1 and attempt == 0:
        raise httpx.WriteTimeout("stalled")


def _refused(page: int, attempt: int, size: int):
    # Every attempt of the page at its first size is refused: an answer at that size could only fail again.
    if page == 1 and size > LARGE:
        return httpx.Response(401, json={"detail": "invalid connector access token"})


@pytest.mark.parametrize(
    ("failure", "bad_call", "first_answer"),
    [(_stall, -1, "WriteTimeout"), (_refused, 1, 401)],
    ids=["stalled-page", "token-outlived-by-the-page"],
)
def test_a_capture_re_paged_on_the_way_rebuilds_the_same_timeline_and_writes_nothing(
    tmp_path, monkeypatch, rows_touched, failure, bad_call, first_answer,
):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client, runtime="dsh")
    monkeypatch.setattr(ingest_module, "SNAPSHOT_MIN_PAGE_BYTES", 1024)
    # The 401 below came after "a long body". The constant exists only with the token rule: without
    # the rule this case fails by what the Connector does, not by a name.
    if hasattr(ingest_module, "SNAPSHOT_TOKEN_OUTLIVED_SECONDS"):
        monkeypatch.setattr(ingest_module, "SNAPSHOT_TOKEN_OUTLIVED_SECONDS", 0.0)
    reference = [(f"tl_{index}", index) for index in range(ITEMS)]

    path = _Path(client.app, 1, failure)
    _upload(client.app, access_token, session_id, path, bad_call=bad_call)
    first, failed, again = path.attempts[:3]
    assert [(sent.page, sent.attempt) for sent in (first, failed, again)] == [(0, 0), (1, 0), (1, 1)], "page 1 did not land once"
    assert path.statuses[:3] == [200, first_answer, 200] and again.size < failed.size, "the next attempt was smaller and landed"
    assert again.range["afterOrderSeq"] == failed.range["afterOrderSeq"], "and it is the same page, re-cut from its own start"
    assert _walks_the_timeline_once(path), "the pages walk the timeline once, none sent again"
    assert _timeline(client, session_id, headers) == reference, "every item once, in order"

    # The same capture again, unchanged, cut at the same page: no row is written.
    seen = rows_touched(client)
    path = _Path(client.app, 1, failure)
    _upload(client.app, access_token, session_id, path, bad_call=bad_call)
    first, failed, again = path.attempts[:3]
    assert [(sent.page, sent.attempt) for sent in (first, failed, again)] == [(0, 0), (1, 0), (1, 1)]
    assert path.statuses[:3] == [200, first_answer, 200] and again.size < failed.size
    assert seen == {"written": [], "deleted": []}, "a re-paged capture of an unchanged timeline writes no timeline row"
    assert _timeline(client, session_id, headers) == reference


def test_a_capture_whose_first_page_is_cut_still_replaces_its_part_of_the_earlier_timeline(tmp_path, monkeypatch):
    client = make_client(tmp_path)
    _, access_token, session_id, headers = create_connector_and_session(client, runtime="dsh")
    monkeypatch.setattr(ingest_module, "SNAPSHOT_MIN_PAGE_BYTES", 1024)
    # Earlier history, sent as one page, holds an item the new capture no longer has, inside the
    # range the first page will cover.
    former = dict(_item(session_id, 1), id="tl_former")
    _ingest(
        client, access_token, session_id,
        [_item(session_id, index, "x" * 400) for index in range(ITEMS)] + [former], complete=True,
    )
    earlier = _timeline(client, session_id, headers)
    assert len(earlier) == ITEMS + 1 and ("tl_former", 1) in earlier, "the earlier history holds the item at sequence 1"

    def stall_first(page: int, attempt: int, size: int):
        if page == 0 and attempt == 0:
            raise httpx.WriteTimeout("stalled")

    path = _Path(client.app, 0, stall_first)
    _upload(client.app, access_token, session_id, path)
    stalled, again = path.attempts[:2]
    assert (stalled.page, again.page, again.attempt) == (0, 0, 1), "the first page did not land once"
    assert path.statuses[:2] == ["WriteTimeout", 200] and again.size < stalled.size, "the next attempt was smaller and landed"
    assert again.opens_capture and again.complete, "and it opens the capture again, marked complete"
    assert again.range["throughOrderSeq"] < stalled.range["throughOrderSeq"] and again.range["throughOrderSeq"] >= 1, (
        "the re-cut first page still covers the item the capture no longer holds"
    )
    assert _walks_the_timeline_once(path)
    assert _timeline(client, session_id, headers) == [(f"tl_{index}", index) for index in range(ITEMS)], "that item is gone"
