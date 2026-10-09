"""Pi live-session lifecycle edges that need no Pi process."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtimes.pi import runtime as runtime_module
from connector.runtimes.pi.runtime import PiLiveSession, PiRuntime, platform_session_id
from connector.server.capabilities import protocol_capabilities_from_runtime_types

from .conftest import FakeHost, wait_for
from .test_timeline_sync import make_runtime, user, write_session


def live_session(runtime: PiRuntime, session_id: str, tmp_path: Path, path: str | None = None):
    live = PiLiveSession(runtime, session_id, cwd=str(tmp_path), session_path=path)
    runtime._live[session_id] = live
    return live


async def test_ensure_live_rejects_session_paths_outside_sessions_dir(
    tmp_path: Path, fake_host: FakeHost
) -> None:
    outside = tmp_path / "elsewhere" / "secret.jsonl"
    write_session(outside, user("u1", None, "hi", 1))
    runtime = make_runtime(tmp_path, fake_host)
    for external_id in (str(outside), str(tmp_path / "sessions" / ".." / "elsewhere" / "x.jsonl")):
        with pytest.raises(RuntimeInvalidRequestError):
            await runtime._ensure_live("sess-x", external_id, None)
    assert runtime._live == {}


async def test_reannounce_includes_live_sessions_not_yet_on_disk(
    tmp_path: Path, fake_host: FakeHost
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    new = live_session(runtime, "sess-new", tmp_path, str(tmp_path / "sessions" / "new.jsonl"))
    new.is_streaming = True
    await runtime.reannounce_session_states(reason="backend-reconnect")
    assert [(state["session_id"], state["status"]) for state in fake_host.states] == [
        ("sess-new", "running")
    ]


async def test_failed_or_cancelled_reannounce_does_not_start_the_cooldown(
    tmp_path: Path, fake_host: FakeHost, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    calls = 0

    async def failing_inventory(*_: Any, **__: Any):
        nonlocal calls
        calls += 1
        raise OSError("sessions directory unavailable")

    monkeypatch.setattr(runtime, "list_complete_session_inventory", failing_inventory)
    await runtime.reannounce_session_states(reason="reconnect")
    await runtime.reannounce_session_states(reason="reconnect")
    assert calls == 2

    release = asyncio.Event()

    async def slow_inventory(*_: Any, **__: Any):
        nonlocal calls
        calls += 1
        await release.wait()
        return ()

    monkeypatch.setattr(runtime, "list_complete_session_inventory", slow_inventory)
    task = asyncio.create_task(runtime.reannounce_session_states(reason="reconnect"))
    await wait_for(lambda: calls == 3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    release.set()
    await runtime.reannounce_session_states(reason="reconnect")
    assert calls == 4
    # A complete pass does start it.
    await runtime.reannounce_session_states(reason="reconnect")
    assert calls == 4


@pytest.mark.parametrize(
    "stop_reason,abort,outcome",
    [
        ("stop", False, "completed"),
        ("aborted", False, "interrupted"),
        ("toolUse", True, "interrupted"),
        ("error", False, "failed"),
    ],
)
async def test_turn_end_outcome_follows_how_the_run_ended(
    tmp_path: Path, fake_host: FakeHost, stop_reason: str, abort: bool, outcome: str
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    live = live_session(runtime, "sess-run", tmp_path)
    await runtime.handle_live_event(live, {"type": "agent_start"})
    live.abort_requested = abort
    await runtime.handle_live_event(
        live,
        {"type": "message_end", "message": {"role": "assistant", "content": [], "stopReason": stop_reason}},
    )
    await runtime.handle_live_event(live, {"type": "agent_settled"})
    assert [end["outcome"] for end in fake_host.turn_ends] == [outcome]
    # The next run starts from a clean slate.
    await runtime.handle_live_event(live, {"type": "agent_start"})
    await runtime.handle_live_event(live, {"type": "agent_settled"})
    assert fake_host.turn_ends[-1]["outcome"] == "completed"


async def test_process_exit_during_a_run_closes_the_turn(
    tmp_path: Path, fake_host: FakeHost
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    idle = live_session(runtime, "sess-idle", tmp_path)
    await runtime.handle_live_exit(idle, 0)
    assert fake_host.turn_ends == []

    running = live_session(runtime, "sess-crash", tmp_path)
    await runtime.handle_live_event(running, {"type": "agent_start"})
    await runtime.handle_live_exit(running, 1)
    assert fake_host.turn_ends == [
        {"session_id": "sess-crash", "runtime": "pi", "external_session_id": None, "outcome": "failed"}
    ]
    assert fake_host.states[-1]["status"] == "idle"


async def test_settle_closes_dialogs_pi_resolved_itself(
    tmp_path: Path, fake_host: FakeHost
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    runtime._idle_timeout = 0.01
    live = live_session(runtime, "sess-dialog", tmp_path)
    await runtime.handle_live_event(live, {"type": "agent_start"})
    await runtime.handle_live_event(
        live,
        {"type": "extension_ui_request", "id": "ui-1", "method": "select", "title": "Pick", "options": ["a"]},
    )
    assert live.status == "waiting_approval"
    await runtime.handle_live_event(live, {"type": "agent_settled"})
    assert live.pending_ui == {}
    assert live.status == "idle"
    closed = [notice for notice in fake_host.notices if notice.notice_id == "pi-ui-ui-1"]
    assert [notice.status for notice in closed] == ["open", "cancelled"]
    assert closed[-1].blocking is None
    assert fake_host.states[-1]["status"] == "idle"
    live.last_activity -= 1.0
    await runtime._reclaim_idle_sessions()
    assert "sess-dialog" not in runtime._live


async def test_settle_keeps_dialogs_opened_outside_the_run(
    tmp_path: Path, fake_host: FakeHost
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    live = live_session(runtime, "sess-idle-dialog", tmp_path)
    await runtime.handle_live_event(
        live, {"type": "extension_ui_request", "id": "ui-3", "method": "confirm", "title": "Sure?"}
    )
    await runtime.handle_live_event(live, {"type": "agent_start"})
    await runtime.handle_live_event(live, {"type": "agent_settled"})
    assert list(live.pending_ui) == ["ui-3"]
    assert live.status == "waiting_approval"


async def test_timed_out_dialog_expires_without_a_pi_event(
    tmp_path: Path, fake_host: FakeHost, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(runtime_module, "DIALOG_TIMEOUT_GRACE_SECONDS", 0.0)
    runtime = make_runtime(tmp_path, fake_host)
    live = live_session(runtime, "sess-timeout", tmp_path)
    await runtime.handle_live_event(
        live,
        {"type": "extension_ui_request", "id": "ui-2", "method": "input", "title": "Name?", "timeout": 30},
    )
    assert live.status == "waiting_approval"
    await wait_for(lambda: not live.pending_ui)
    await wait_for(lambda: fake_host.notices[-1].status == "expired")
    await wait_for(lambda: fake_host.states[-1]["status"] == "idle")


async def test_platform_created_session_path_survives_restart_without_a_scan(
    tmp_path: Path, fake_host: FakeHost, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "sessions" / "--project--" / "created.jsonl"
    write_session(path, user("u1", None, "hi", 1))
    runtime = make_runtime(tmp_path, fake_host)
    live = live_session(runtime, "sess-created", tmp_path, str(path))
    await runtime._persist_permission(live)

    restarted = make_runtime(tmp_path, fake_host)

    def no_scan(*_: Any, **__: Any) -> None:
        raise AssertionError("the persisted index must avoid a directory scan")

    monkeypatch.setattr(restarted, "_scan_session_path", no_scan)
    monkeypatch.setattr(restarted.directory, "list_sessions", no_scan)
    assert await restarted._resolve_session_path("sess-created", None) == path
    state = await restarted.get_session_state("sess-created")
    assert state is not None and state.external_session_id == str(path)


async def test_inventory_id_resolves_from_file_names_off_the_event_loop(
    tmp_path: Path, fake_host: FakeHost, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "sessions" / "--project--" / "found.jsonl"
    write_session(path, user("u1", None, "hi", 1))
    runtime = make_runtime(tmp_path, fake_host)

    def no_summaries(*_: Any, **__: Any) -> None:
        raise AssertionError("resolving an id must not summarize every session file")

    monkeypatch.setattr(runtime.directory, "list_sessions", no_summaries)
    threads: list[Any] = []
    original = asyncio.to_thread

    async def recording_to_thread(function, *args, **kwargs):
        threads.append(function)
        return await original(function, *args, **kwargs)

    monkeypatch.setattr(runtime_module.asyncio, "to_thread", recording_to_thread)
    session_id = platform_session_id(fake_host.session_namespace, str(path))
    assert await runtime._resolve_session_path(session_id, None) == path
    assert runtime._scan_session_path in threads


async def test_runtime_capabilities_use_the_runtime_channel_and_discovery_keeps_pi(
    tmp_path: Path,
) -> None:
    class Host(FakeHost):
        def __init__(self) -> None:
            super().__init__()
            self.runtime_sets: list[Any] = []

        async def runtime_capabilities_update(self, capabilities: Any) -> None:
            self.runtime_sets.append(capabilities)

    host = Host()
    runtime = make_runtime(tmp_path, host)
    await runtime._publish_runtime_capabilities()
    assert host.capability_sets == []
    assert [capability_set.session_id for capability_set in host.runtime_sets] == [None]

    from connector.runtimes.pi.provider import pi_capabilities

    payload = protocol_capabilities_from_runtime_types(
        {"runtimeTypes": [{"runtimeType": "pi", "available": True, "capabilities": pi_capabilities()}]}
    )
    by_id = {(item["runtime"], item["capabilityId"]): item for item in payload["capabilities"]}
    assert by_id[("pi", "session.send_message")]["available"] is True
    assert by_id[("pi", "runtime.attachment")]["available"] is True

