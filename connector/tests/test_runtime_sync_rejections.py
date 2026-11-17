"""History sync pages large timelines and backs off a session the Server refuses for good."""

from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest
from test_connector_runtime import (
    FakeAgentRuntime,
    FakeRuntimeSupervisor,
    RecordingRuntimeHost,
    _client,
    unused_notification_sender,
)

from connector.runtime_protocol import (
    PreparedSessionTimelineSync,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionState,
)
from connector.server import runtime_sync
from connector.server.errors import ConnectorNetworkError
from connector.server.ingest import ConnectorIngestClient
from connector.server.runtime_sync import RuntimeSyncRunner

PROXY_LIMIT = 64 * 1024


def _meta(session_id: str) -> SessionMeta:
    return SessionMeta(
        session_id=session_id,
        external_session_id=f"ext_{session_id}",
        runtime="claude",
        title=session_id,
        ordering_time="2026-11-09T00:00:00Z",
        metadata={"sync": {"changed": True, "requires_timeline_sync": True}},
    )


def _item(session_id: str, index: int, size: int) -> RuntimeTimelineItem:
    return RuntimeTimelineItem(
        id=f"{session_id}_{index}",
        session_id=session_id,
        type="message",
        status="completed",
        role="assistant",
        order_seq=index,
        content_hash=f"sha256:{index}",
        turn_id="turn_private",
        content={"text": "x" * size},
        source={"runtime": "claude", "event": "test"},
    )


class _Runtime(FakeAgentRuntime):
    """Claude-like history: each session hands out a partial snapshot until committed."""

    def __init__(self, histories: dict[str, list[RuntimeTimelineItem]]) -> None:
        super().__init__(runtime_id="claude")
        self.histories = histories
        self.reads: list[str] = []
        self.commits: list[str] = []

    async def list_sessions(self, limit: int = 100, cursor: str | None = None, force: bool = False):
        return tuple(_meta(session_id) for session_id in self.histories if session_id not in self.commits)

    async def get_session_state(self, session_id: str, external_session_id: str | None = None):
        return SessionState(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="claude",
            status="idle",
        )

    async def prepare_session_timeline_sync(self, session_id: str, external_session_id: str | None = None):
        self.reads.append(session_id)

        async def commit() -> None:
            self.commits.append(session_id)

        return PreparedSessionTimelineSync(
            snapshot=RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=external_session_id,
                runtime="claude",
                items=tuple(self.histories[session_id]),
                complete=False,
            ),
            commit=commit,
        )


class _Proxy(httpx.AsyncBaseTransport):
    """An ingress that answers 413 above ``PROXY_LIMIT`` and records what it let through."""

    def __init__(self) -> None:
        self.accepted: list[dict[str, Any]] = []
        self.refused: list[int] = []
        self.fail_with: Exception | None = None

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raw = b"".join([chunk async for chunk in request.stream])
        if self.fail_with is not None:
            raise self.fail_with
        if len(raw) > PROXY_LIMIT:
            self.refused.append(len(raw))
            return httpx.Response(413, request=request)
        self.accepted.append(json.loads(raw))
        return httpx.Response(200, json={}, request=request)

    def notifications(self) -> list[dict[str, Any]]:
        return [n for body in self.accepted for n in body["notifications"]]


class _Harness:
    def __init__(self, histories: dict[str, list[RuntimeTimelineItem]], *, page_bytes: int = 256 * 1024) -> None:
        self.runtime = _Runtime(histories)
        self.proxy = _Proxy()
        self.http = httpx.AsyncClient(transport=self.proxy)
        self.ingest = ConnectorIngestClient(
            "http://test", AsyncMock(return_value="token"), lambda: self.http, lambda _: self.http,
            snapshot_page_bytes=page_bytes,
        )
        self.runner = RuntimeSyncRunner(
            config=_client().config,
            supervisor=FakeRuntimeSupervisor(self.runtime),  # type: ignore[arg-type]
            host=RecordingRuntimeHost(),
            preferences_reader=dict,
            send_notification=unused_notification_sender,
            ingest_notifications=self.ingest.ingest_notifications,
            ingest_snapshot=self.ingest.ingest_snapshot,
        )

    async def scan(self) -> None:
        self.runtime.reads.clear()
        self.proxy.accepted.clear()
        self.proxy.refused.clear()
        await self.runner.sync_existing_once()


@pytest.fixture(autouse=True)
def _no_retry_sleep(monkeypatch):
    from connector.server import ingest

    monkeypatch.setattr(ingest, "SNAPSHOT_MIN_PAGE_BYTES", 16 * 1024)
    monkeypatch.setattr(ingest, "SNAPSHOT_PAGE_RETRY_BACKOFF_SECONDS", 0)
    monkeypatch.setattr(ingest, "SYNC_BATCH_RETRY_BACKOFF_SECONDS", 0)


def test_history_above_the_ingress_limit_is_uploaded_in_pages():
    async def run() -> None:
        items = [_item("sess_big", index, 6_000) for index in range(40)]
        harness = _Harness({"sess_big": items})
        async with harness.http:
            await harness.scan()
        # The first page at the configured size was refused, then the history was re-paged.
        assert harness.proxy.refused
        syncs = [n for n in harness.proxy.notifications() if n["method"] == "timeline.sync"]
        assert len(syncs) > 1
        assert all(sync["params"]["complete"] is False for sync in syncs), "a partial history never replaces"
        assert [item["id"] for sync in syncs for item in sync["params"]["items"]] == [item.id for item in items]
        assert all("turnId" not in json.dumps(sync) for sync in syncs)
        last = [n["method"] for n in harness.proxy.accepted[-1]["notifications"]]
        assert last[-2:] == ["session.state.updated", "notice.upsert"], "state and notices follow the last item"
        methods = [n["method"] for n in harness.proxy.notifications()]
        assert methods.count("session.meta.upsert") == 1
        assert methods.count("session.state.updated") == 1
        assert harness.runtime.commits == ["sess_big"]

    asyncio.run(run())


def test_small_history_is_still_one_request():
    async def run() -> None:
        harness = _Harness({"sess_small": [_item("sess_small", 0, 100)]})
        async with harness.http:
            await harness.scan()
        assert len(harness.proxy.accepted) == 1
        assert [n["method"] for n in harness.proxy.accepted[0]["notifications"]] == [
            "session.meta.upsert",
            "timeline.sync",
            "session.state.updated",
            "notice.upsert",
        ]
        assert harness.runtime.commits == ["sess_small"]

    asyncio.run(run())


def test_refused_session_is_isolated_and_backs_off(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(runtime_sync.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(runtime_sync.random, "uniform", lambda low, high: 1.0)

    async def run() -> None:
        # One item larger than the ingress accepts cannot be cut any smaller.
        harness = _Harness({
            "sess_huge": [_item("sess_huge", 0, 100), _item("sess_huge", 1, PROXY_LIMIT * 2)],
            "sess_ok": [_item("sess_ok", 0, 100)],
        })
        async with harness.http:
            await harness.scan()
            assert harness.runtime.reads == ["sess_huge", "sess_ok"]
            assert harness.runtime.commits == ["sess_ok"], "the other session still syncs in the same scan"
            # The refused session still reports its meta and state, without its timeline.
            light = [n for n in harness.proxy.notifications() if n["params"]["sessionId"] == "sess_huge"]
            assert "session.state.updated" in [n["method"] for n in light]
            assert harness.runner._recovered.get("claude") == harness.runner._recovery_generation

            # Following scans neither read nor upload it, nor repeat the unchanged state.
            await harness.scan()
            assert harness.runtime.reads == []
            assert harness.proxy.accepted == [] and harness.proxy.refused == []

            # After the backoff it is tried once more, then waits twice as long.
            clock[0] += runtime_sync.TIMELINE_REJECTION_BACKOFF_SECONDS
            await harness.scan()
            assert harness.runtime.reads == ["sess_huge"]
            assert harness.runner._timeline_backoffs["sess_huge"].failures == 2
            clock[0] += runtime_sync.TIMELINE_REJECTION_BACKOFF_SECONDS
            await harness.scan()
            assert harness.runtime.reads == []
            clock[0] += runtime_sync.TIMELINE_REJECTION_BACKOFF_SECONDS
            await harness.scan()
            assert harness.runtime.reads == ["sess_huge"]

            # Once it fits (here: the item shrank), it syncs and the backoff ends.
            harness.runtime.histories["sess_huge"] = [_item("sess_huge", 0, 100)]
            clock[0] += runtime_sync.TIMELINE_REJECTION_BACKOFF_MAX_SECONDS
            await harness.scan()
            assert harness.runtime.commits == ["sess_ok", "sess_huge"]
            assert "sess_huge" not in harness.runner._timeline_backoffs

    asyncio.run(run())


def test_transient_failures_are_retried_on_the_next_scan():
    async def run() -> None:
        harness = _Harness({"sess_a": [_item("sess_a", 0, 100)]})
        async with harness.http:
            harness.proxy.fail_with = httpx.ConnectError("down")
            with pytest.raises(ConnectorNetworkError):
                await harness.runner.sync_existing_session(harness.runtime, _meta("sess_a"))
            assert harness.runner._timeline_backoffs == {}
            harness.proxy.fail_with = None
            await harness.scan()
            assert harness.runtime.reads == ["sess_a"]
            assert harness.runtime.commits == ["sess_a"]

    asyncio.run(run())


@pytest.mark.parametrize(
    ("status", "permanent"),
    [(413, True), (400, True), (422, True), (408, False), (429, False), (503, False)],
)
def test_only_client_errors_count_as_permanent(status, permanent):
    request = httpx.Request("POST", "http://test")
    error = httpx.HTTPStatusError("x", request=request, response=httpx.Response(status, request=request))
    assert runtime_sync._permanently_rejected(error) is permanent


def test_retryable_rejections_do_not_pause_the_session():
    """A Server-side lock wait is retried on the next scan, not backed off for minutes."""

    from connector.server.ingest import (
        ConnectorIngestRejectedError,
        ConnectorIngestRetryableError,
    )

    assert runtime_sync._permanently_rejected(ConnectorIngestRetryableError("lock busy")) is False
    assert runtime_sync._permanently_rejected(ConnectorIngestRejectedError("invalid")) is True
