from __future__ import annotations

import asyncio
import base64
import json
import time
from pathlib import Path

import pytest

from connector.runtime_protocol import (
    CAPABILITY_RUNTIME_ATTACHMENT,
    CAPABILITY_SESSION_SEND_MESSAGE,
    RuntimeAttachment,
    RuntimeConfig,
)
from connector.runtimes.pi.runtime import PiRuntime, platform_session_id

from .conftest import FAKE_PNG_BYTES, FakeHost, wait_for


def make_runtime(fake_pi: Path, tmp_path: Path, host: FakeHost) -> PiRuntime:
    config = RuntimeConfig(
        runtime="pi",
        revision=1,
        values={
            "executablePath": str(fake_pi),
            "sessionsDir": str(tmp_path / "sessions"),
            "defaultCwd": str(tmp_path),
            "requestTimeoutMs": 5000,
        },
    )
    return PiRuntime(config=config, host=host)


async def test_start_stop(fake_pi: Path, tmp_path: Path, fake_host: FakeHost) -> None:
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    assert runtime.identity.runtime_version == "9.9.9-fake"
    await runtime.stop()


async def test_create_and_start_session(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
    session_file: Path,
) -> None:
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        result = await runtime.create_and_start_session(
            "sess-abc",
            "你好",
            title="测试会话",
            cwd=str(tmp_path),
        )
        assert result.ok is True
        await wait_for(lambda: len(fake_host.timeline_syncs) >= 1)
        await wait_for(lambda: any(state.get("status") == "idle" for state in fake_host.states))
    finally:
        await runtime.stop()

    synced = fake_host.timeline_syncs[-1]
    assert synced["runtime"] == "pi"
    assert synced["complete"] is True
    kinds = [item.type for item in synced["items"]]
    assert "message" in kinds
    # session metadata carries the pi file path
    assert session_file.is_file()


async def test_state_change_publishes_session_capabilities(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
) -> None:
    """Capability facts must be published, not only answered on request.

    The platform caches capability facts only from runtime notifications, and
    snapshot and websocket projections fall back to that cache when a live
    read fails; without a publish the cached set stays empty and clients see
    every session action as unavailable.
    """

    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session(
            "sess-caps",
            "hello",
            cwd=str(tmp_path),
        )
        await wait_for(lambda: len(fake_host.capability_sets) >= 1)
    finally:
        await runtime.stop()

    published = fake_host.capability_sets[-1]
    assert published.session_id == "sess-caps"
    by_id = {capability.capability_id: capability for capability in published.capabilities}
    assert "session.send_message" in by_id
    send = by_id["session.send_message"]
    assert send.supported and send.available and send.allowed


async def test_list_sessions_and_snapshot(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
    session_file: Path,
) -> None:
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        result = await runtime.create_and_start_session("sess-abc", "你好", cwd=str(tmp_path))
        assert result.ok is True
        await wait_for(lambda: session_file.is_file())
        # The settle push records the file as synced before notifying the host;
        # wait for it so the scanner check below cannot race the async push.
        await wait_for(lambda: len(fake_host.timeline_syncs) >= 1)

        sessions = await runtime.list_sessions()
        assert len(sessions) == 1
        session = sessions[0]
        expected_platform_id = platform_session_id(fake_host.session_namespace, str(session_file))
        assert session.session_id == expected_platform_id
        assert session.external_session_id == str(session_file)
        # The settle push already published this session's timeline, so the
        # scanner has nothing to re-sync until the file changes again.
        assert session.metadata["sync"]["requires_timeline_sync"] is False

        snapshot = await runtime.get_session_snapshot(session.session_id, str(session_file))
        assert snapshot.complete is True
        assert snapshot.external_session_id == str(session_file)
        assert any(item.type == "message" for item in snapshot.items)

        # Touching the file marks the session for a fresh timeline sync.
        session_file.write_text(session_file.read_text(encoding="utf-8") + "\n")
        sessions = await runtime.list_sessions()
        assert sessions[0].metadata["sync"]["changed"] is True

        # A plain read is not a sync; only a sync the platform accepted is.
        await runtime.get_session_snapshot(sessions[0].session_id, sessions[0].external_session_id)
        sessions = await runtime.list_sessions()
        assert sessions[0].metadata["sync"]["changed"] is True
        prepared = await runtime.prepare_session_timeline_sync(
            sessions[0].session_id, sessions[0].external_session_id
        )
        await prepared.commit()
        sessions = await runtime.list_sessions()
        assert sessions[0].metadata["sync"]["changed"] is False

        state = await runtime.get_session_state(session.session_id, str(session_file))
        assert state is not None
        assert state.status == "idle"
    finally:
        await runtime.stop()


async def test_extension_ui_interaction_flow(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
    session_file: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("PI_FAKE_UI", "confirm")
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("sess-ui", "确认一下", cwd=str(tmp_path))
        await wait_for(lambda: any(notice.type == "interaction" for notice in fake_host.notices))
        notices = await runtime.get_session_notices("sess-ui")
        assert len(notices) == 1
        notice = notices[0]
        assert notice.response_required is True
        assert any(action["actionId"] == "confirm" for action in notice.actions)

        result = await runtime.respond_interaction("sess-ui", notice.notice_id, "confirm")
        assert result.ok is True
        # The fake settles after the UI response and the runtime publishes it.
        await wait_for(lambda: len(fake_host.timeline_syncs) >= 1)
        resolved = [n for n in fake_host.notices if n.status == "resolved"]
        assert resolved, "interaction notice should be resolved"
    finally:
        await runtime.stop()


async def test_model_catalog_and_selections(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
    session_file: Path,
) -> None:
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        catalog = await runtime.list_model_catalog()
        ids = [model.id for model in catalog.models]
        # Pi can expose the same model name under several providers; ids must
        # stay unique or the platform rejects the whole catalog.
        assert ids == ["test:test-model", "test:other-model", "alt:test-model"]
        assert len(ids) == len(set(ids))
        assert catalog.models[0].selection_id == "test:test-model"
        # Ambiguous names carry the provider so the workbench can tell them
        # apart; unambiguous names stay untouched.
        titles = [model.title for model in catalog.models]
        assert titles == ["Test Model（test）", "Other Model", "Test Model（alt）"]
        filtered = await runtime.list_model_catalog(query="alt")
        assert [model.id for model in filtered.models] == ["alt:test-model"]
        # Labels are computed over the full directory, so filtering keeps them.
        assert filtered.models[0].title == "Test Model（alt）"

        await runtime.create_and_start_session("sess-model", "hi", cwd=str(tmp_path))
        result = await runtime.update_session_selections(
            "sess-model", None, {"model": "test:other-model", "thinkingLevel": "high"}
        )
        assert result.ok is True
        state = await runtime.get_session_state("sess-model")
        assert state is not None
        # A reasoning model reports its reasoning item, as clients select it.
        assert state.selections["model"] == "test:other-model#high"
        assert state.selections["thinkingLevel"] == "high"
    finally:
        await runtime.stop()


async def test_commands_are_listed(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
    session_file: Path,
) -> None:
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        commands = await runtime.list_commands("sess-none")
        assert [command.id for command in commands] == ["compact", "fix-tests"]
        assert all(command.accepts_args for command in commands)
    finally:
        await runtime.stop()


def write_messages_session(path: Path, count: int) -> None:
    """Write a session file holding ``count`` chained user messages."""

    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        {
            "type": "session",
            "version": 3,
            "id": "session-many",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "cwd": "/tmp/project",
        }
    ]
    parent: str | None = None
    for index in range(count):
        entry_id = f"ent{index:05d}"
        lines.append(
            {
                "type": "message",
                "id": entry_id,
                "parentId": parent,
                "timestamp": "2026-01-01T00:00:02.000Z",
                "message": {
                    "role": "user",
                    "content": f"message {index}",
                    "timestamp": 1767225602000 + index,
                },
            }
        )
        parent = entry_id
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")


async def test_truncated_snapshot_is_not_complete(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost
) -> None:
    session_file = tmp_path / "sessions" / "--tmp--" / "many.jsonl"
    write_messages_session(session_file, 10)
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        full = await runtime.get_session_snapshot("sess-many", str(session_file))
        assert full.complete is True
        assert len(full.items) > 3

        limited = await runtime.get_session_snapshot("sess-many", str(session_file), limit=3)
        # A truncated tail must not claim to be the Runtime-owned full history;
        # the platform replaces stored timelines from complete snapshots.
        assert limited.complete is False
        assert [item.id for item in limited.items] == [item.id for item in full.items[-3:]]
    finally:
        await runtime.stop()


async def test_concurrent_ensure_live_shares_one_session(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
    session_file: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import time

    # The session file must exist so resolution goes through the slow branch
    # below; a missing file would resolve synchronously without a race window.
    write_messages_session(session_file, 3)

    # Widen the window between the duplicate check and the registration so the
    # race is deterministic instead of relying on event-loop luck.
    def slow_session_cwd(path: Path) -> str | None:
        time.sleep(0.05)
        return None

    monkeypatch.setattr(PiRuntime, "_session_cwd", staticmethod(slow_session_cwd))
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        first, second = await asyncio.gather(
            runtime._ensure_live("sess-conc", str(session_file), None),
            runtime._ensure_live("sess-conc", str(session_file), None),
        )
        assert first is second
        assert len(runtime._live) == 1
    finally:
        await runtime.stop()


async def test_snapshot_rejects_paths_outside_sessions_dir(
    fake_pi: Path, tmp_path: Path, fake_host: FakeHost
) -> None:
    outside = tmp_path / "outside" / "stray.jsonl"
    write_messages_session(outside, 2)
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        snapshot = await runtime.get_session_snapshot("sess-outside", str(outside))
        assert snapshot.complete is False
        assert snapshot.metadata.get("reason") == "session file not found"
        assert snapshot.items == ()
    finally:
        await runtime.stop()


def test_model_display_title_rules() -> None:
    from connector.runtimes.pi.runtime import _model_display_title

    directory = [
        ("DeepSeek V4.1 Flash", "deepseek", "deepseek-flash"),
        ("DeepSeek V4.1 Flash", "opencode-go", "deepseek-v4.1-flash"),
        ("DeepSeek V4 Pro", "deepseek", "deepseek-v4-pro"),
        ("Routed", "test", "a"),
        ("Routed", "test", "b"),
    ]
    # Same name under several providers: provider suffix.
    assert (
        _model_display_title("DeepSeek V4.1 Flash", "deepseek", "deepseek-flash", directory)
        == "DeepSeek V4.1 Flash（deepseek）"
    )
    # Unique name: untouched.
    assert (
        _model_display_title("DeepSeek V4 Pro", "deepseek", "deepseek-v4-pro", directory)
        == "DeepSeek V4 Pro"
    )
    # Same provider, several ids under one name: append the model id.
    assert _model_display_title("Routed", "test", "a", directory) == "Routed [a]"
    assert _model_display_title("Solo", "test", "s", directory) == "Solo"


def test_catalog_revision_is_monotonic_across_restarts(tmp_path: Path) -> None:
    """The platform drops catalogs whose revision does not exceed the stored
    one, so a restarted connector must still produce larger revisions."""

    def make() -> PiRuntime:
        return PiRuntime(
            config=RuntimeConfig(
                runtime="pi",
                revision=1,
                values={
                    "executablePath": "pi",
                    "sessionsDir": str(tmp_path / "sessions"),
                    "defaultCwd": str(tmp_path),
                    "requestTimeoutMs": 5000,
                },
            ),
            host=FakeHost(),
        )

    first = make()
    revisions = [first._next_catalog_revision() for _ in range(3)]
    assert revisions == sorted(revisions)
    assert len(set(revisions)) == 3
    # A real connector restart takes at least milliseconds; the clock-based
    # revision then exceeds the previous process even though it restarted from
    # an empty in-memory counter.
    time.sleep(0.005)
    restarted = make()
    assert restarted._next_catalog_revision() > revisions[-1]


async def test_start_turn_forwards_image_attachments(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
    session_file: Path,
) -> None:
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        attachment = RuntimeAttachment(
            file_id="file-1",
            name="shot.png",
            media_type="image/png",
            size=len(FAKE_PNG_BYTES),
            sha256="0" * 64,
        )
        result = await runtime.start_turn(
            "sess-img",
            None,
            "看看这张图",
            attachments=(attachment,),
        )
        assert result.ok is True
        await wait_for(
            lambda: (
                session_file.is_file() and "看看这张图" in session_file.read_text(encoding="utf-8")
            )
        )
    finally:
        await runtime.stop()

    assert fake_host.attachment_downloads == [{"session_id": "sess-img", "file_id": "file-1"}]
    records = [
        json.loads(line)
        for line in session_file.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    user_message = next(
        record["message"]
        for record in records
        if record.get("type") == "message" and (record.get("message") or {}).get("role") == "user"
    )
    blocks = user_message["content"]
    assert isinstance(blocks, list)
    image = next(block for block in blocks if block.get("type") == "image")
    assert image["mimeType"] == "image/png"
    assert image["data"] == base64.b64encode(FAKE_PNG_BYTES).decode("ascii")


async def test_start_resets_stale_running_states(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
) -> None:
    """A restart re-announces idle for sessions the platform may see as running."""

    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    session = sessions_dir / "restart.jsonl"
    session.write_text(
        json.dumps(
            {
                "type": "session",
                "version": 3,
                "id": "sess-restart",
                "cwd": str(tmp_path),
                "timestamp": "t",
            }
        )
        + "\n"
        + json.dumps(
            {
                "type": "message",
                "id": "u1",
                "parentId": None,
                "timestamp": "t",
                "message": {"role": "user", "content": "你好", "timestamp": 1},
            }
        )
        + "\n",
        encoding="utf-8",
    )
    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await wait_for(lambda: any(state.get("status") == "idle" for state in fake_host.states))
        state = next(item for item in fake_host.states if item.get("status") == "idle")
        assert state["runtime"] == "pi"
        assert state["session_id"].startswith("sess_pi_")
    finally:
        await runtime.stop()


def write_pi_session_file(path: Path, *, session_id: str, cwd: str) -> None:
    """A minimal pi session file: header line plus one user message."""

    path.write_text(
        json.dumps(
            {
                "type": "session",
                "version": 3,
                "id": session_id,
                "cwd": cwd,
                "timestamp": "t",
            }
        )
        + "\n"
        + json.dumps(
            {
                "type": "message",
                "id": "u1",
                "parentId": None,
                "timestamp": "t",
                "message": {"role": "user", "content": "你好", "timestamp": 1},
            }
        )
        + "\n",
        encoding="utf-8",
    )


async def test_reannounce_session_states_after_reconnect(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
    session_file: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Backend state caches converge after a reconnect without killing live sessions."""

    import connector.runtimes.pi.runtime as runtime_module

    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    imported = sessions_dir / "imported.jsonl"
    write_pi_session_file(imported, session_id="sess-imported", cwd=str(tmp_path))

    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        imported_session_id = platform_session_id(fake_host.session_namespace, str(imported))
        await wait_for(
            lambda: any(
                state.get("session_id") == imported_session_id for state in fake_host.states
            )
        )
        # A platform-created session keeps its platform id as the live key,
        # while the inventory knows the same session under a path-derived id.
        await runtime.create_and_start_session("sess-live", "你好", cwd=str(tmp_path))
        await wait_for(lambda: "sess-live" in runtime._live)
        # Let the run settle so the announced status cannot race its events.
        await wait_for(lambda: len(fake_host.turn_ends) == 1)
        live = runtime._live["sess-live"]
        assert live.status == "idle"

        monkeypatch.setattr(runtime_module, "REANNOUNCE_MIN_INTERVAL_SECONDS", 0.0)
        fake_host.states.clear()
        await runtime.reannounce_session_states(reason="reconnect")

        announced = {state["session_id"]: state for state in fake_host.states}
        assert set(announced) == {imported_session_id, "sess-live"}
        assert announced[imported_session_id]["status"] == "idle"
        assert announced["sess-live"]["status"] == live.status
        assert announced["sess-live"]["metadata"]["sessionFile"] == live.session_file
    finally:
        await runtime.stop()


async def test_reannounce_session_states_skips_repeats_within_interval(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
) -> None:
    """A reconnect storm must not trigger repeated full inventory scans."""

    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir(parents=True, exist_ok=True)
    write_pi_session_file(
        sessions_dir / "imported.jsonl", session_id="sess-imported", cwd=str(tmp_path)
    )

    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await wait_for(lambda: any(state.get("status") == "idle" for state in fake_host.states))
        fake_host.states.clear()
        await runtime.reannounce_session_states(reason="reconnect")
        assert fake_host.states == []
    finally:
        await runtime.stop()


async def test_start_turn_attaches_client_message_id(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
) -> None:
    """The projected user item carries the id the platform dedupes with."""

    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.start_turn("sess-cm", None, "你好", client_message_id="cm-42")
        await wait_for(
            lambda: any(
                item.source.get("clientMessageId") == "cm-42"
                for sync in fake_host.timeline_syncs
                for item in sync["items"]
            )
        )
    finally:
        await runtime.stop()


async def test_reclaims_idle_sessions(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
) -> None:
    """Idle pi processes are closed; the session file remains for revival."""

    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("sess-idle", "你好", cwd=str(tmp_path))
        live = runtime._live["sess-idle"]
        assert live.alive
        runtime._idle_timeout = 0.05
        live.last_activity -= 1.0
        await runtime._reclaim_idle_sessions()
        assert "sess-idle" not in runtime._live
        await wait_for(lambda: not live.alive)
    finally:
        await runtime.stop()


async def test_keeps_active_sessions_during_reclaim(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
) -> None:
    """A streaming session must survive an idle reclaim pass."""

    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session("sess-busy", "你好", cwd=str(tmp_path))
        live = runtime._live["sess-busy"]
        runtime._idle_timeout = 0.05
        live.is_streaming = True
        live.last_activity -= 1.0
        await runtime._reclaim_idle_sessions()
        assert runtime._live.get("sess-busy") is live
        assert live.alive
    finally:
        runtime._live["sess-busy"].is_streaming = False
        await runtime.stop()


async def test_create_session_skips_placeholder_title(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
) -> None:
    """AA's default title must not be written into the pi session file."""

    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session(
            "sess-placeholder",
            "你好",
            title="新建会话",
            cwd=str(tmp_path),
        )
        live = runtime._live["sess-placeholder"]
        assert live.session_name is None
    finally:
        await runtime.stop()


async def test_runtime_start_publishes_runtime_capabilities(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
) -> None:
    """start() pushes runtime-scoped facts so the platform persists them."""

    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        published = [item for item in fake_host.capability_sets if item.session_id is None]
    finally:
        await runtime.stop()

    assert published, "start() should publish runtime-scoped capability facts"
    by_id = {capability.capability_id: capability for capability in published[-1].capabilities}
    assert by_id[CAPABILITY_RUNTIME_ATTACHMENT].scope == "runtime"
    assert by_id[CAPABILITY_SESSION_SEND_MESSAGE].scope == "runtime"


async def test_runtime_capabilities_advertise_attachments(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
) -> None:
    """The device-runtime endpoint (new-session composer) reads this set."""

    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        capability_set = await runtime.get_runtime_capabilities()
    finally:
        await runtime.stop()

    by_id = {capability.capability_id: capability for capability in capability_set.capabilities}
    attachment = by_id[CAPABILITY_RUNTIME_ATTACHMENT]
    assert attachment.scope == "runtime"
    assert attachment.supported is True
    assert attachment.available is True
    assert attachment.allowed is True
    # The AA server matches allowedMimeTypes literally (no wildcard support),
    # so the runtime must omit the list to accept every attachment type.
    assert "allowedMimeTypes" not in attachment.metadata
    # Session actions are advertised at runtime scope too so the platform's
    # per-session projection has a fallback for sessions without own facts.
    assert by_id[CAPABILITY_SESSION_SEND_MESSAGE].scope == "runtime"


async def test_client_message_bindings_survive_connector_restart(
    fake_pi: Path,
    tmp_path: Path,
    fake_host: FakeHost,
    session_file: Path,
) -> None:
    """A restart must not orphan an in-flight optimistic send.

    The platform reconciles optimistic sends by client message id from the
    transcript projection; losing the id across a connector restart leaves
    the echo showing next to the local copy (duplicate messages).
    """

    runtime = make_runtime(fake_pi, tmp_path, fake_host)
    await runtime.start()
    try:
        await runtime.create_and_start_session(
            "sess-live",
            "你好",
            cwd=str(tmp_path),
            client_message_id="opt_test_restart",
        )
        await wait_for(lambda: session_file.is_file())
    finally:
        await runtime.stop()

    restarted = make_runtime(fake_pi, tmp_path, fake_host)
    await restarted.start()
    try:
        snapshot = await restarted.get_session_snapshot(
            "sess-live",
            external_session_id=str(session_file),
        )
        user_items = [
            item
            for item in snapshot.items
            if item.type == "message" and getattr(item, "role", None) == "user"
        ]
        assert user_items, "expected the projected user message"
        assert user_items[-1].source.get("clientMessageId") == "opt_test_restart"
    finally:
        await restarted.stop()
