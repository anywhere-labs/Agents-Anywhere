"""History sync pages large timelines and backs off a session the Server refuses for good."""

from __future__ import annotations

import asyncio
import json
from dataclasses import replace
from types import SimpleNamespace
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


def _meta(session_id: str, *, timeline: bool = True) -> SessionMeta:
    return SessionMeta(
        session_id=session_id,
        external_session_id=f"ext_{session_id}",
        runtime="claude",
        title=session_id,
        ordering_time="2026-11-09T00:00:00Z",
        metadata={"sync": {"changed": True, "requires_timeline_sync": timeline}},
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
        self.no_timeline: set[str] = set()

    async def list_sessions(self, limit: int = 100, cursor: str | None = None, force: bool = False):
        return tuple(
            _meta(session_id, timeline=session_id not in self.no_timeline)
            for session_id in self.histories if session_id not in self.commits
        )

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
        self.stall_pages = False
        # With stall_pages: the sessions whose pages stall. None: every page.
        self.stall_only: set[str] | None = None

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        raw = b"".join([chunk async for chunk in request.stream])
        if self.fail_with is not None:
            raise self.fail_with
        if self.stall_pages and b'"method":"timeline.sync"' in raw and (
            self.stall_only is None or any(f'"sessionId":"{session_id}"'.encode() in raw for session_id in self.stall_only)
        ):
            raise httpx.WriteTimeout("stalled")
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
            snapshot_wait=self.ingest.snapshot_wait,
        )

    async def scan(self) -> None:
        self.runtime.reads.clear()
        self.proxy.accepted.clear()
        self.proxy.refused.clear()
        await self.runner.sync_existing_once()


def _backoff_over(runner: RuntimeSyncRunner, session_id: str) -> None:
    """Let the backoff of a timeline run out, as ten minutes would."""
    runner._timeline_backoffs[session_id] = replace(runner._timeline_backoffs[session_id], retry_at=0.0)


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


def test_a_stalled_timeline_waits_its_own_backoff_and_the_rest_syncs_once_the_cool_down_is_over(monkeypatch):
    from connector.server import ingest as ingest_module

    monkeypatch.setattr(ingest_module, "SNAPSHOT_STALL_WAIT_SECONDS", 0.5)

    def metas(harness) -> list[str]:
        return [n["params"].get("sessionId") for n in harness.proxy.notifications() if n["method"] == "session.meta.upsert"]

    def timelines(harness) -> list[str]:
        return [n for n in harness.proxy.notifications() if n["method"] == "timeline.sync"]

    async def run() -> None:
        harness = _Harness({
            "sess_stalled": [_item("sess_stalled", 0, 100)],
            "sess_next": [_item("sess_next", 0, 100)],
            "sess_last": [_item("sess_last", 0, 100)],
            "sess_meta_only": [],
        })
        async with harness.http:
            harness.runtime.no_timeline = {"sess_meta_only"}
            harness.proxy.stall_pages = True
            await harness.scan()
            # The stalled page was given up at once and its timeline is backed off for ten minutes of
            # its own. The scan went on to the next session, which the cool-down refused unsent, and
            # that ends the timeline reads of this scan...
            assert harness.runtime.reads == ["sess_stalled", "sess_next"]
            assert harness.runtime.commits == [] and timelines(harness) == []
            # ...while the stalled session and the one ordered after it that needs no timeline
            # still published their meta (and the stalled one its state).
            assert metas(harness) == ["sess_stalled", "sess_meta_only"]
            assert harness.runner._recovered.get("claude") != harness.runner._recovery_generation

            # While the wait is on, every scan reads no history at all, one line, the rest published.
            await harness.scan()
            assert harness.runtime.reads == [] and metas(harness) == ["sess_meta_only"]
            assert harness.proxy.accepted, "small batches pass during a wait"

            # The wait is over and the path carries pages again: everything else syncs and the scan
            # completes. The stalled timeline is not so much as read before its own backoff.
            harness.proxy.stall_pages = False
            await asyncio.sleep(0.6)
            await harness.scan()
            assert harness.runtime.reads == ["sess_next", "sess_last"]
            assert harness.runtime.commits == ["sess_next", "sess_last"]
            assert harness.runner._recovered.get("claude") == harness.runner._recovery_generation

            # Ten minutes on it is read again, and syncs now that the path carries pages.
            _backoff_over(harness.runner, "sess_stalled")
            await harness.scan()
            assert harness.runtime.reads == ["sess_stalled"]
            assert harness.runtime.commits == ["sess_next", "sess_last", "sess_stalled"]
            assert "sess_stalled" not in harness.runner._timeline_backoffs

    asyncio.run(run())


def test_a_scan_that_is_only_a_recovery_reads_no_timeline_during_a_wait_either(monkeypatch):
    from connector.server import ingest as ingest_module

    monkeypatch.setattr(ingest_module, "SNAPSHOT_STALL_WAIT_SECONDS", 0.5)

    async def run() -> None:
        harness = _Harness({
            "sess_starter": [_item("sess_starter", 0, 100)],
            "sess_next": [_item("sess_next", 0, 100)],
        })
        async with harness.http:
            # A scan with one session asking for its timeline stalls: the wait is on. The scan went on
            # to the next session, which the wait refused unsent.
            harness.proxy.stall_pages = True
            await harness.scan()
            assert harness.runtime.reads == ["sess_starter", "sess_next"]
            # The backend reconnected: every session is to be recovered.
            await harness.runner.reconnect_event_runtimes()

            # No session asks for a timeline now; the scan is here only to recover. A recovery
            # reads a history as well.
            harness.runtime.no_timeline = {"sess_starter", "sess_next"}
            await harness.scan()
            assert harness.runtime.reads == [], "a recovery scan during a wait reads no history"
            assert harness.runner._recovered.get("claude") != harness.runner._recovery_generation

            # The wait is over: the recovery reads the other one and completes. The stalled timeline
            # waits its own backoff under a recovery the same as under any other scan.
            harness.proxy.stall_pages = False
            await asyncio.sleep(0.6)
            await harness.scan()
            assert harness.runtime.reads == ["sess_next"]
            assert harness.runner._recovered.get("claude") == harness.runner._recovery_generation
            # Its backoff over, the session asks for its timeline again and it gets through.
            harness.runtime.no_timeline = set()
            _backoff_over(harness.runner, "sess_starter")
            await harness.scan()
            assert harness.runtime.reads == ["sess_starter"] and harness.runtime.commits == ["sess_next", "sess_starter"]
    asyncio.run(run())


def test_a_scan_with_nothing_to_read_is_not_reported_as_deferred_during_a_wait(monkeypatch):
    from connector.server import ingest as ingest_module
    from connector.server import runtime_sync

    monkeypatch.setattr(ingest_module, "SNAPSHOT_STALL_WAIT_SECONDS", 0.5)

    async def run() -> None:
        harness = _Harness({
            "sess_starter": [_item("sess_starter", 0, 100)],
            "sess_next": [_item("sess_next", 0, 100)],
        })
        lines: list[str] = []
        sink = runtime_sync.logger.add(lines.append, level="WARNING")
        async with harness.http:
            try:
                harness.proxy.stall_pages = True
                await harness.scan()
                assert harness.runtime.reads == ["sess_starter", "sess_next"], "the scan went on to the next session, which the wait refused unsent"
                # Steady state: no session asks for a timeline, and no recovery is due.
                harness.runtime.no_timeline = {"sess_starter", "sess_next"}
                del lines[:]
                await harness.scan()
                assert harness.runtime.reads == []
                assert not [line for line in lines if "existing session sync deferred" in line], lines
            finally:
                runtime_sync.logger.remove(sink)
    asyncio.run(run())


def test_a_timeline_whose_own_page_stalled_is_not_read_again_before_its_backoff(monkeypatch):
    """A polling runtime on a weak link: with a cool-down of a minute the same
    too-large timeline was read and stalled again at every scan, 23 times in 22 minutes, and the
    sessions ordered after it got their turn only in between. Held back by its own backoff it
    stalls at the first scan and once more when the ten minutes ran out: twice."""
    from connector.server import ingest as ingest_module

    # One clock for the ingest client and the runner: minutes pass at a stroke.
    clock = [1000.0]
    monkeypatch.setattr(ingest_module, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(runtime_sync, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(runtime_sync.random, "uniform", lambda low, high: 1.0)

    async def run() -> None:
        lines: list[str] = []
        sink = runtime_sync.logger.add(lines.append, level="WARNING")
        harness = _Harness({
            "sess_stalled": [_item("sess_stalled", 0, 100)],
            "sess_small": [_item("sess_small", 0, 100)],
        })
        stalled_reads: list[float] = []
        try:
            async with harness.http:
                # One timeline is too much for the path; the other would pass in a second.
                harness.proxy.stall_pages, harness.proxy.stall_only = True, {"sess_stalled"}
                # A scan a minute for 22 minutes, as the runner schedules them.
                for minute in range(23):
                    await harness.scan()
                    clock[0] += 60.0
                    if "sess_stalled" in harness.runtime.reads:
                        stalled_reads.append(minute * 60.0)
                    if minute == 0:
                        # The stall backs the timeline off at once; the session after it is refused
                        # unsent while the client cools down.
                        assert harness.runtime.reads == ["sess_stalled", "sess_small"]
                        assert harness.runtime.commits == []
                    if minute == 1:
                        assert harness.runtime.commits == ["sess_small"], "the session after it syncs a minute later"
                assert stalled_reads == [0.0, 600.0], "read again only once its backoff ran out; the next one is twenty minutes"
                assert harness.runner._timeline_backoffs["sess_stalled"].failures == 2
                stalled = [line for line in lines if "existing session timeline stalled; skipping it" in line]
                assert len(stalled) == 2 and "for 600s" in stalled[0] and "for 1200s" in stalled[1], lines
                deferred = [line for line in lines if "existing session sync deferred" in line]
                assert len(deferred) == 1 and "session_id=sess_small" in deferred[0], lines

                # The path carries pages again: once the backoff ran out, the timeline syncs and the backoff ends.
                harness.proxy.stall_pages = False
                clock[0] += runtime_sync.TIMELINE_REJECTION_BACKOFF_MAX_SECONDS
                await harness.scan()
                assert harness.runtime.reads == ["sess_stalled"]
                assert harness.runtime.commits == ["sess_small", "sess_stalled"]
                assert "sess_stalled" not in harness.runner._timeline_backoffs
        finally:
            runtime_sync.logger.remove(sink)

    asyncio.run(run())
