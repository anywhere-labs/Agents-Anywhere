from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from connector.claude.adapter import ClaudeAdapter
from connector.claude.path_utils import encode_cwd, stable_claude_session_id


def _write_session(projects_dir: Path, cwd: str, uuid: str, events: list[dict[str, Any]]) -> Path:
    bucket = projects_dir / encode_cwd(cwd)
    bucket.mkdir(parents=True, exist_ok=True)
    p = bucket / f"{uuid}.jsonl"
    p.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
    return p


def test_encode_cwd_replaces_separators(tmp_path: Path) -> None:
    encoded = encode_cwd("/Users/benson/Documents/foo")
    # Note: macOS may resolve symlinks; the suffix is what matters here.
    assert encoded.endswith("-Documents-foo")
    assert "/" not in encoded
    assert "." not in encoded


def test_stable_session_id_is_deterministic() -> None:
    a = stable_claude_session_id("conn_1", "uuid-x")
    b = stable_claude_session_id("conn_1", "uuid-x")
    c = stable_claude_session_id("conn_2", "uuid-x")
    assert a == b
    assert a != c
    assert a.startswith("sess_claude_")


def test_sync_existing_sessions_emits_notifications_for_each_jsonl(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    _write_session(projects, "/repo/a", "11111111-1111-1111-1111-111111111111", [
        {"type": "user", "uuid": "u1", "message": {"content": "first"}, "cwd": "/repo/a"},
        {"type": "assistant", "uuid": "a1", "message": {
            "content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn"
        }},
    ])
    _write_session(projects, "/repo/b", "22222222-2222-2222-2222-222222222222", [
        {"type": "user", "uuid": "u2", "message": {"content": "second"}, "cwd": "/repo/b"},
        {"type": "assistant", "uuid": "a2", "message": {
            "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"
        }},
    ])
    adapter = ClaudeAdapter(projects_dir=projects)
    received: list[dict[str, Any]] = []

    async def sink(notifications: list[dict[str, Any]]) -> None:
        received.extend(notifications)

    result = asyncio.run(adapter.sync_existing_sessions("conn_x", notification_sink=sink))
    assert len(result["threads"]) == 2
    assert result["skippedThreads"] == []

    methods = [n["method"] for n in received]
    # Each session contributes a session.updated + timeline.sync.
    assert methods.count("session.updated") == 2
    assert methods.count("timeline.sync") == 2

    session_ids = {n["params"]["sessionId"] for n in received if n["method"] == "session.updated"}
    expected_a = stable_claude_session_id("conn_x", "11111111-1111-1111-1111-111111111111")
    expected_b = stable_claude_session_id("conn_x", "22222222-2222-2222-2222-222222222222")
    assert session_ids == {expected_a, expected_b}


def test_sync_skips_unchanged_files_on_second_pass(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    _write_session(projects, "/repo/c", "33333333-3333-3333-3333-333333333333", [
        {"type": "user", "uuid": "u3", "message": {"content": "x"}, "cwd": "/repo/c"},
        {"type": "assistant", "uuid": "a3", "message": {
            "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"
        }},
    ])
    adapter = ClaudeAdapter(projects_dir=projects)
    received_first: list[dict[str, Any]] = []
    received_second: list[dict[str, Any]] = []

    async def first(n): received_first.extend(n)
    async def second(n): received_second.extend(n)

    asyncio.run(adapter.sync_existing_sessions("conn_x", notification_sink=first))
    asyncio.run(adapter.sync_existing_sessions("conn_x", notification_sink=second))

    assert len(received_first) >= 2  # session.updated + timeline.sync
    assert received_second == []  # nothing changed → no re-push


def test_sync_skips_live_sdk_session_without_advancing_cursor(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    claude_uuid = "55555555-5555-5555-5555-555555555555"
    path = _write_session(projects, "/repo/live", claude_uuid, [
        {"type": "user", "uuid": "u5", "message": {"content": "live"}, "cwd": "/repo/live"},
        {"type": "assistant", "uuid": "a5", "message": {
            "content": [{"type": "text", "text": "streaming"}], "stop_reason": "end_turn"
        }},
    ])
    adapter = ClaudeAdapter(projects_dir=projects)
    adapter.skip_live_session_ids = {claude_uuid}
    received: list[dict[str, Any]] = []

    async def sink(n): received.extend(n)

    result = asyncio.run(adapter.sync_existing_sessions("conn_x", notification_sink=sink))

    assert result["threads"] == []
    assert result["skippedThreads"] == [claude_uuid]
    assert received == []
    assert path not in adapter._cursors


def test_sync_force_flag_bypasses_cursor(tmp_path: Path) -> None:
    projects = tmp_path / "projects"
    _write_session(projects, "/repo/d", "44444444-4444-4444-4444-444444444444", [
        {"type": "user", "uuid": "u4", "message": {"content": "x"}, "cwd": "/repo/d"},
        {"type": "assistant", "uuid": "a4", "message": {
            "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"
        }},
    ])
    adapter = ClaudeAdapter(projects_dir=projects)
    asyncio.run(adapter.sync_existing_sessions("conn_x"))
    forced: list[dict[str, Any]] = []

    async def sink(n): forced.extend(n)

    asyncio.run(adapter.sync_existing_sessions("conn_x", force=True, notification_sink=sink))
    assert len(forced) >= 2


def test_missing_projects_dir_returns_empty(tmp_path: Path) -> None:
    adapter = ClaudeAdapter(projects_dir=tmp_path / "no-such-dir")
    result = asyncio.run(adapter.sync_existing_sessions("conn_x"))
    assert result == {"threads": [], "skippedThreads": [], "backendNotifications": []}


def test_resolve_approval_unknown_session_is_noop(tmp_path: Path) -> None:
    """Task 5 implements resolve_approval. Unknown session → soft no-op."""
    adapter = ClaudeAdapter(projects_dir=tmp_path / "projects")
    r = asyncio.run(adapter.resolve_approval({
        "sessionId": "sess_unknown", "approvalId": "appr_x", "status": "approved",
    }))
    assert r["resolved"] is False


def test_limit_truncates_oldest_first(tmp_path: Path) -> None:
    import time as _t
    projects = tmp_path / "projects"
    paths = []
    for i in range(3):
        p = _write_session(
            projects, f"/repo/limit_{i}", f"{i:08x}-0000-0000-0000-000000000000",
            [
                {"type": "user", "uuid": f"u{i}", "message": {"content": f"m{i}"}, "cwd": f"/repo/limit_{i}"},
                {"type": "assistant", "uuid": f"a{i}", "message": {
                    "content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"
                }},
            ],
        )
        paths.append(p)
        _t.sleep(0.01)  # stagger mtimes so sort order is stable
    adapter = ClaudeAdapter(projects_dir=projects)
    result = asyncio.run(adapter.sync_existing_sessions("conn_x", limit=2))
    assert len(result["threads"]) == 2
