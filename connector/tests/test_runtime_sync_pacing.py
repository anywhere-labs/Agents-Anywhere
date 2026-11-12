"""The scan loop spreads its load and reports an inventory only when it changed."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from typing import Any

import pytest
from test_connector_runtime import (
    FakeAgentRuntime,
    FakeRuntimeSupervisor,
    RecordingRuntimeHost,
    _client,
    unused_notification_sender,
)

from connector.runtime_protocol import SessionMeta, SessionSourceState
from connector.server import runtime_sync
from connector.server.runtime_sync import RuntimeSyncRunner


def _session(
    session_id: str = "sess_1",
    *,
    availability: str = "available",
    observed_at: str = "2026-11-06T00:00:00Z",
) -> SessionMeta:
    return SessionMeta(
        session_id=session_id,
        external_session_id=f"thr_{session_id}",
        runtime="codex",
        metadata={"sync": {"changed": False}},
        source_state=SessionSourceState(
            availability=availability,
            reason="codex.thread/list active",
            observed_at=observed_at,
            observation_origin="inventory",
        ),
    )


class _Runtime(FakeAgentRuntime):
    runtime_id = "codex"

    def __init__(self, log: list[str]) -> None:
        super().__init__(runtime_id="codex")
        self.log = log
        self.sessions: tuple[SessionMeta, ...] = (_session(),)

    async def list_complete_session_inventory(
        self, page_size: int = 100, force: bool = False
    ) -> tuple[SessionMeta, ...]:
        self.log.append("list")
        return self.sessions


class _Harness:
    def __init__(self) -> None:
        self.log: list[str] = []
        self.runtime = _Runtime(self.log)
        self.host = RecordingRuntimeHost()
        self.reject_complete = False
        self.runner = RuntimeSyncRunner(
            config=_client().config,
            supervisor=FakeRuntimeSupervisor(self.runtime),  # type: ignore[arg-type]
            host=self.host,
            preferences_reader=dict,
            send_notification=unused_notification_sender,
            ingest_notifications=self._ingest,
        )

    async def _ingest(self, notifications: list[dict[str, Any]]) -> None:
        for notification in notifications:
            method = notification["method"]
            if method == "session.inventory.complete" and self.reject_complete:
                raise RuntimeError("complete rejected")
            if method.startswith("session.inventory."):
                self.log.append(method.rsplit(".", 1)[1])

    async def scan(self) -> list[str]:
        self.log.clear()
        await self.runner.sync_existing_once()
        return list(self.log)


def test_unchanged_inventory_is_listed_but_not_reported_again():
    async def run() -> None:
        harness = _Harness()
        assert await harness.scan() == ["begin", "list", "complete"]
        for minute in range(1, 3):
            harness.runtime.sessions = (
                _session(observed_at=f"2026-11-06T00:0{minute}:00Z"),
            )
            assert await harness.scan() == ["list"]
        # The Server keeps the state from the report; no per-session update either.
        assert [event for event in harness.host.events if event[0] == "source"] == []

    asyncio.run(run())


@pytest.mark.parametrize(
    "changed",
    [
        (_session(availability="archived"),),
        (_session(), _session("sess_new")),
        (),
    ],
    ids=["state", "new-session", "gone"],
)
def test_changed_inventory_begins_a_scan_before_listing_again(changed):
    async def run() -> None:
        harness = _Harness()
        await harness.scan()
        harness.runtime.sessions = changed
        assert await harness.scan() == ["list", "begin", "list", "complete"]
        assert await harness.scan() == ["list"]

    asyncio.run(run())


def test_unchanged_inventory_is_reported_again_after_the_reconcile_window(monkeypatch):
    async def run() -> None:
        harness = _Harness()
        await harness.scan()
        assert await harness.scan() == ["list"]
        monkeypatch.setattr(runtime_sync.time, "monotonic", lambda: float("inf"))
        assert await harness.scan() == ["begin", "list", "complete"]

    asyncio.run(run())


def test_reconnect_reports_the_inventory_on_the_next_scan():
    async def run() -> None:
        harness = _Harness()
        await harness.scan()
        await harness.runner.reconnect_event_runtimes()
        assert await harness.scan() == ["begin", "list", "complete"]

    asyncio.run(run())


def test_unaccepted_report_is_sent_again():
    async def run() -> None:
        harness = _Harness()
        harness.reject_complete = True
        assert await harness.scan() == ["begin", "list"]
        harness.reject_complete = False
        assert await harness.scan() == ["begin", "list", "complete"]

    asyncio.run(run())


def test_recovery_forces_a_limited_number_of_sessions_per_scan(monkeypatch):
    async def run() -> None:
        monkeypatch.setattr(runtime_sync, "RECOVERY_SESSIONS_PER_SCAN", 2)
        harness = _Harness()
        harness.runtime.sessions = tuple(_session(f"sess_{i}") for i in range(5))
        recovered: list[list[str]] = []

        async def sync_existing_session(_runtime, session, **kwargs):
            if kwargs["recovering"]:
                recovered[-1].append(session.session_id)
            return True

        monkeypatch.setattr(
            harness.runner, "sync_existing_session", sync_existing_session
        )
        generation = harness.runner._recovery_generation + 1
        await harness.runner.reconnect_event_runtimes()
        for expected in (
            ["sess_0", "sess_1"],
            ["sess_2", "sess_3"],
        ):
            recovered.append([])
            await harness.runner.sync_existing_once()
            assert recovered[-1] == expected
            assert harness.runner._recovered.get("codex") != generation
        recovered.append([])
        await harness.runner.sync_existing_once()
        assert recovered[-1] == ["sess_4"]
        assert harness.runner._recovered["codex"] == generation

    asyncio.run(run())


def test_scan_loop_spreads_its_start_and_interval(monkeypatch):
    async def run() -> None:
        harness = _Harness()
        harness.runner.config = replace(
            harness.runner.config, sync_existing_on_connect=True
        )
        interval = harness.runner.config.sync_interval_seconds
        sleeps: list[float] = []

        async def sleep(seconds: float) -> None:
            sleeps.append(seconds)
            if len(sleeps) == 40:
                raise asyncio.CancelledError

        monkeypatch.setattr(runtime_sync.asyncio, "sleep", sleep)
        with pytest.raises(asyncio.CancelledError):
            await harness.runner.sync_existing_loop()

        initial, *periods = sleeps
        assert 0 <= initial <= runtime_sync.INITIAL_SYNC_JITTER_SECONDS
        assert all(interval * 0.8 <= period <= interval * 1.2 for period in periods)
        assert len(set(periods)) > 1

    asyncio.run(run())


def test_reconnect_delay_is_spread_above_the_configured_wait():
    client = _client(reconnect_seconds=3)
    delays = [client._reconnect_delay() for _ in range(50)]
    assert all(3 <= delay <= 6 for delay in delays)
    assert len(set(delays)) > 1
