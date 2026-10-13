"""Checkpointed, incremental Pi timeline sync (prepare -> publish -> commit)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.pi import projection, sessions
from connector.runtimes.pi.runtime import PiLiveSession, PiRuntime

from .conftest import FakeHost


def make_runtime(tmp_path: Path, host: FakeHost) -> PiRuntime:
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
        host=host,
    )


def user(entry_id: str, parent: str | None, text: str, timestamp: int) -> dict[str, Any]:
    return {
        "type": "message",
        "id": entry_id,
        "parentId": parent,
        "timestamp": "t",
        "message": {"role": "user", "content": text, "timestamp": timestamp},
    }


def assistant(entry_id: str, parent: str, text: str, timestamp: int) -> dict[str, Any]:
    return {
        "type": "message",
        "id": entry_id,
        "parentId": parent,
        "timestamp": "t",
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "stopReason": "stop",
            "timestamp": timestamp,
        },
    }


def write_session(path: Path, *entries: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = {"type": "session", "version": 3, "id": "s", "timestamp": "t", "cwd": str(path.parent)}
    path.write_text(
        "".join(json.dumps(record) + "\n" for record in (header, *entries)), encoding="utf-8"
    )


def append_session(path: Path, *entries: dict[str, Any]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        for record in entries:
            handle.write(json.dumps(record) + "\n")


def item_id(path: Path, item_type: str, key: str) -> str:
    return projection.item_id(str(path), item_type, key)


def content_ids(items) -> set[str]:
    return {item.id for item in items if item.type not in {"turn.start", "turn.end"}}


async def inventory_entry(runtime: PiRuntime):
    sessions = await runtime.list_complete_session_inventory()
    assert len(sessions) == 1
    return sessions[0]


@pytest.fixture
def session_path(tmp_path: Path) -> Path:
    path = tmp_path / "sessions" / "--project--" / "one.jsonl"
    write_session(path, user("u1", None, "hello", 1), assistant("a1", "u1", "hi", 2))
    return path


async def test_first_sync_replaces_and_only_commit_marks_synced(
    tmp_path: Path, fake_host: FakeHost, session_path: Path
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    meta = await inventory_entry(runtime)
    assert meta.metadata["sync"]["requires_timeline_sync"] is True

    prepared = await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert prepared is not None and prepared.snapshot is not None
    # No checkpoint: the platform may hold history from an older connector, so
    # the first sync is a complete replacement, as Pi always sent before.
    assert prepared.snapshot.complete is True
    assert content_ids(prepared.snapshot.items) == {
        item_id(session_path, "message", "user:timestamp:1:1"),
        item_id(session_path, "message", "assistant:timestamp:2:1:text:1"),
    }
    # A read alone is not a sync: an RPC snapshot or a failed upload must not
    # mark the file as synced.
    await runtime.get_session_snapshot(meta.session_id, meta.external_session_id)
    assert (await inventory_entry(runtime)).metadata["sync"]["requires_timeline_sync"] is True

    assert prepared.commit is not None
    await prepared.commit()
    assert (await inventory_entry(runtime)).metadata["sync"]["requires_timeline_sync"] is False


async def test_appended_history_is_incremental(
    tmp_path: Path, fake_host: FakeHost, session_path: Path
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    meta = await inventory_entry(runtime)
    first = await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    await first.commit()

    append_session(session_path, user("u2", "a1", "again", 3), assistant("a2", "u2", "sure", 4))
    meta = await inventory_entry(runtime)
    assert meta.metadata["sync"]["requires_timeline_sync"] is True
    prepared = await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert prepared.snapshot is not None
    assert prepared.snapshot.complete is False
    assert content_ids(prepared.snapshot.items) == {
        item_id(session_path, "message", "user:timestamp:3:1"),
        item_id(session_path, "message", "assistant:timestamp:4:1:text:1"),
    }


async def test_uncommitted_sync_is_retried_with_the_same_delta(
    tmp_path: Path, fake_host: FakeHost, session_path: Path
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    meta = await inventory_entry(runtime)
    await (await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)).commit()
    append_session(session_path, user("u2", "a1", "again", 3))

    failed = await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    # The upload failed, so commit() is never called.
    assert (await inventory_entry(runtime)).metadata["sync"]["requires_timeline_sync"] is True
    retried = await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert retried.snapshot is not None and failed.snapshot is not None
    assert retried.snapshot.complete is failed.snapshot.complete is False
    assert content_ids(retried.snapshot.items) == content_ids(failed.snapshot.items)


async def test_restart_does_not_reupload_unchanged_history(
    tmp_path: Path, fake_host: FakeHost, session_path: Path
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    meta = await inventory_entry(runtime)
    await (await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)).commit()

    restarted = make_runtime(tmp_path, fake_host)
    assert (await inventory_entry(restarted)).metadata["sync"]["requires_timeline_sync"] is False
    unchanged = await restarted.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert unchanged.snapshot is None


async def test_branch_switch_replaces_the_timeline(
    tmp_path: Path, fake_host: FakeHost, session_path: Path
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    meta = await inventory_entry(runtime)
    await (await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)).commit()

    # /tree back to u1: the active branch no longer contains a1.
    append_session(session_path, assistant("b1", "u1", "other answer", 5))
    prepared = await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert prepared.snapshot is not None
    assert prepared.snapshot.complete is True
    assert item_id(session_path, "message", "assistant:timestamp:2:1:text:1") not in content_ids(
        prepared.snapshot.items
    )
    assert item_id(session_path, "message", "user:timestamp:1:1") in content_ids(prepared.snapshot.items)


async def test_invalid_checkpoint_replaces_the_timeline(
    tmp_path: Path, fake_host: FakeHost, session_path: Path
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    meta = await inventory_entry(runtime)
    fake_host.sync_state[runtime._timeline_checkpoint_key(str(session_path))] = {"version": 99}
    prepared = await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert prepared.snapshot is not None and prepared.snapshot.complete is True


async def test_new_item_before_a_streamed_item_replaces_the_timeline(
    tmp_path: Path, fake_host: FakeHost, session_path: Path
) -> None:
    """The platform appends new IDs after its newest row and keeps existing rows
    in place. A user message that precedes an already streamed reply can only
    be placed correctly by a complete replacement."""

    runtime = make_runtime(tmp_path, fake_host)
    meta = await inventory_entry(runtime)
    await (await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)).commit()

    append_session(session_path, user("u2", "a1", "again", 3), assistant("a2", "u2", "sure", 4))
    final = (await runtime.get_session_snapshot(meta.session_id, meta.external_session_id)).items
    reply = next(item for item in final if item.id == item_id(session_path, "message", "assistant:timestamp:4:1:text:1"))
    await runtime._publish_stream_item(str(session_path), reply)
    assert fake_host.timeline_items == [reply]

    prepared = await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert prepared.snapshot is not None and prepared.snapshot.complete is True
    await prepared.commit()
    assert runtime._stream_ids.get(str(session_path)) is None

    append_session(session_path, user("u3", "a2", "third", 6))
    later = await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert later.snapshot is not None and later.snapshot.complete is False


async def test_streamed_ids_missing_from_the_final_timeline_are_removed(
    tmp_path: Path, fake_host: FakeHost, session_path: Path
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    meta = await inventory_entry(runtime)
    await (await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)).commit()

    projector = projection.TranscriptProjector(meta.session_id, str(session_path), live_key_anchor="a1")
    projector.apply_message({"role": "custom", "content": "from an extension"}, entry_id=None)
    (live_only,) = projector.items()
    await runtime._publish_stream_item(str(session_path), live_only)
    append_session(
        session_path,
        {
            "type": "message",
            "id": "c1",
            "parentId": "a1",
            "timestamp": "t",
            "message": {"role": "custom", "content": "from an extension", "timestamp": 3},
        },
    )
    prepared = await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert prepared.snapshot is not None and prepared.snapshot.complete is True
    assert live_only.id not in content_ids(prepared.snapshot.items)


async def test_settle_publishes_through_prepare_and_commits_only_after_success(
    tmp_path: Path, session_path: Path
) -> None:
    class FailingHost(FakeHost):
        fail = True

        async def timeline_sync(self, *args: Any, **kwargs: Any) -> None:
            if self.fail:
                raise RuntimeError("ingest rejected")
            await super().timeline_sync(*args, **kwargs)

    host = FailingHost()
    runtime = make_runtime(tmp_path, host)
    meta = await inventory_entry(runtime)
    live = PiLiveSession(runtime, "sess-live", cwd=str(tmp_path), session_path=str(session_path))

    await runtime._publish_timeline(live)
    assert host.timeline_syncs == []
    assert runtime._timeline_checkpoint_key(str(session_path)) not in host.sync_state
    assert (await inventory_entry(runtime)).metadata["sync"]["requires_timeline_sync"] is True

    host.fail = False
    await runtime._publish_timeline(live)
    assert host.timeline_syncs[-1]["complete"] is True
    assert (await inventory_entry(runtime)).metadata["sync"]["requires_timeline_sync"] is False

    append_session(session_path, user("u2", "a1", "again", 3))
    await runtime._publish_timeline(live)
    assert host.timeline_syncs[-1]["complete"] is False
    assert content_ids(host.timeline_syncs[-1]["items"]) == {item_id(session_path, "message", "user:timestamp:3:1")}
    assert meta.session_id != "sess-live"


async def test_restart_after_streaming_before_the_final_sync_replaces_the_timeline(
    tmp_path: Path, fake_host: FakeHost, session_path: Path
) -> None:
    """The reply was streamed, then the connector stopped before the turn's
    final sync. An incremental sync after restart would append the user
    message after the reply the platform already holds."""

    runtime = make_runtime(tmp_path, fake_host)
    meta = await inventory_entry(runtime)
    await (await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)).commit()

    append_session(session_path, user("u2", "a1", "again", 3), assistant("a2", "u2", "sure", 4))
    final = (await runtime.get_session_snapshot(meta.session_id, meta.external_session_id)).items
    reply = next(i for i in final if i.id == item_id(session_path, "message", "assistant:timestamp:4:1:text:1"))
    await runtime._publish_stream_item(str(session_path), reply)

    restarted = make_runtime(tmp_path, fake_host)
    prepared = await restarted.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert prepared.snapshot is not None and prepared.snapshot.complete is True
    await prepared.commit()
    append_session(session_path, user("u3", "a2", "third", 6))
    later = await restarted.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert later.snapshot is not None and later.snapshot.complete is False


async def test_commit_keeps_no_checkpoint_while_streamed_items_are_unreconciled(
    tmp_path: Path, fake_host: FakeHost, session_path: Path
) -> None:
    runtime = make_runtime(tmp_path, fake_host)
    meta = await inventory_entry(runtime)
    key = runtime._timeline_checkpoint_key(str(session_path))
    await (await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)).commit()
    assert key in fake_host.sync_state

    append_session(session_path, user("u2", "a1", "again", 3))
    prepared = await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    # A new run streams after that read and before its commit.
    projector = projection.TranscriptProjector(meta.session_id, str(session_path), live_key_anchor="u2")
    projector.apply_message({"role": "custom", "content": "from an extension"}, entry_id=None)
    (live_only,) = projector.items()
    await runtime._publish_stream_item(str(session_path), live_only)
    await prepared.commit()
    assert key not in fake_host.sync_state

    restarted = make_runtime(tmp_path, fake_host)
    again = await restarted.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert again.snapshot is not None and again.snapshot.complete is True


async def test_oversized_session_stays_listed_as_unavailable(
    tmp_path: Path, fake_host: FakeHost, session_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Leaving an unparsable file out of the complete inventory made the
    platform mark the session missing."""

    monkeypatch.setattr(sessions, "MAX_SESSION_FILE_BYTES", 64)
    runtime = make_runtime(tmp_path, fake_host)
    # A reconnect re-announce reads the inventory without consuming the change.
    (preview,) = await runtime.list_complete_session_inventory(report=False)
    assert preview.metadata["sync"]["changed"] is True

    meta = await inventory_entry(runtime)
    assert meta.external_session_id == str(session_path)
    assert meta.title == "hello"
    assert meta.source_state is not None
    assert (meta.source_state.availability, meta.source_state.reason) == ("unavailable", "history_too_large")
    assert meta.metadata["sync"] == {"changed": True, "requires_timeline_sync": False}
    # Reported once per file version, not on every scan.
    assert (await inventory_entry(runtime)).metadata["sync"]["changed"] is False
    append_session(session_path, user("u2", "a1", "again", 3))
    assert (await inventory_entry(runtime)).metadata["sync"]["changed"] is True

    prepared = await runtime.prepare_session_timeline_sync(meta.session_id, meta.external_session_id)
    assert prepared.snapshot is None


def test_oversized_summary_reads_only_whole_lines_of_its_prefix(
    tmp_path: Path, session_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sessions, "MAX_SESSION_FILE_BYTES", 64)
    header = session_path.read_bytes().split(b"\n", 1)[0] + b"\n"
    monkeypatch.setattr(sessions, "OVERSIZED_SUMMARY_BYTES", len(header) + 10)
    summary = sessions.summarize_session(session_path)
    assert summary is not None and summary.oversized
    # The first user message is cut by the budget, so it is not parsed.
    assert summary.title is None
    assert sessions.load_session_doc(session_path) is None
