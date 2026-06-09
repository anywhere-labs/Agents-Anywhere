"""Write-path tests for ClaudeAdapter.

We don't spawn a real `claude` here — the real-Claude exercise is in
scripts/claude_write_review.py (review dashboard). These tests cover the
deterministic surface area: spawn-arg composition, the per-session lock,
create_session bookkeeping, and turn-completion detection by mocking a
fake JSONL writer."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from connector.claude.adapter import ClaudeAdapter, _SessionRuntime  # type: ignore[attr-defined]
from connector.claude.path_utils import encode_cwd, stable_claude_session_id


def test_spawn_args_first_message_uses_session_id() -> None:
    adapter = ClaudeAdapter()
    args = adapter._build_spawn_args(
        claude_uuid="u-1",
        content="hi",
        mode=None,
        model=None,
        effort=None,
        exists=False,
    )
    assert args[0] == "--session-id"
    assert args[1] == "u-1"
    assert args[-1] == "hi"
    # No --setting-sources without --permission-mode.
    assert "--setting-sources" not in args


def test_spawn_args_subsequent_message_uses_resume() -> None:
    adapter = ClaudeAdapter()
    args = adapter._build_spawn_args(
        claude_uuid="u-1",
        content="continue",
        mode=None,
        model=None,
        effort=None,
        exists=True,
    )
    assert args[:2] == ["--resume", "u-1"]


def test_spawn_args_with_mode_adds_setting_sources() -> None:
    adapter = ClaudeAdapter()
    args = adapter._build_spawn_args(
        claude_uuid="u-1",
        content="hi",
        mode="bypassPermissions",
        model="claude-opus-4-7",
        effort="max",
        exists=True,
    )
    assert "--permission-mode" in args
    assert args[args.index("--permission-mode") + 1] == "bypassPermissions"
    assert "--setting-sources" in args
    assert args[args.index("--setting-sources") + 1] == "project,local"
    assert "--model" in args and args[args.index("--model") + 1] == "claude-opus-4-7"
    assert "--effort" in args and args[args.index("--effort") + 1] == "max"


def test_spawn_args_no_setting_sources_when_only_model_and_effort() -> None:
    """`--setting-sources` is only paired with `--permission-mode`; passing
    just model/effort must not silently bypass user defaults."""
    adapter = ClaudeAdapter()
    args = adapter._build_spawn_args(
        claude_uuid="u-1",
        content="hi",
        mode=None,
        model="claude-opus-4-7",
        effort="high",
        exists=True,
    )
    assert "--setting-sources" not in args


def test_create_session_registers_runtime_and_pushes_session_updated(
    tmp_path: Path,
) -> None:
    adapter = ClaudeAdapter(projects_dir=tmp_path / "projects")
    cwd_dir = tmp_path / "work"
    cwd_dir.mkdir()
    notifs: list[tuple[str, dict[str, Any]]] = []

    async def sink(method, params):
        notifs.append((method, params))

    adapter.notification_sink = sink

    result = asyncio.run(adapter.create_session({
        "connectorId": "conn_x",
        "cwd": str(cwd_dir),
        "title": "My new session",
    }))

    assert result["sessionId"].startswith("sess_claude_")
    assert "externalSessionId" in result
    backend_notifications = result["backendNotifications"]
    assert backend_notifications[0]["method"] == "session.updated"
    assert backend_notifications[0]["params"]["runtime"] == "claude"
    assert backend_notifications[0]["params"]["cwd"] == str(cwd_dir)

    # Session is in the runtime map.
    session_id = result["sessionId"]
    assert session_id in adapter._sessions
    # Pre-trust accepted in our isolated config? It writes to ~/.claude.json
    # which we don't override here — ensure_trust handles errors gracefully.


def test_interrupt_with_no_in_flight_turn_is_noop(tmp_path: Path) -> None:
    adapter = ClaudeAdapter(projects_dir=tmp_path / "projects")
    adapter._sessions["sess_x"] = _SessionRuntime(
        claude_uuid="u-1", session_id="sess_x", cwd=str(tmp_path)
    )
    result = asyncio.run(adapter.interrupt_turn({"sessionId": "sess_x"}))
    assert result["interrupted"] is False


def test_interrupt_unknown_session_is_noop(tmp_path: Path) -> None:
    adapter = ClaudeAdapter(projects_dir=tmp_path / "projects")
    result = asyncio.run(adapter.interrupt_turn({"sessionId": "sess_unknown"}))
    assert result["interrupted"] is False


def test_start_turn_drives_a_synthetic_jsonl_to_completion(tmp_path: Path) -> None:
    """Replace PtyRunner with a fake that writes a synthetic JSONL when
    .spawn() is called. Verify start_turn drives the reducer to a turn.end
    and emits timeline.itemUpsert notifications."""
    from connector.claude import adapter as adapter_module

    cwd_dir = tmp_path / "work"
    cwd_dir.mkdir()
    projects = tmp_path / "projects"

    class FakePty:
        def __init__(self):
            self._alive = True

        def spawn(self, cmd, args, *, cwd=None, env=None, dimensions=None):
            # Simulate Claude writing the JSONL after spawn.
            jsonl_path = projects / encode_cwd(str(cwd_dir)) / f"{claude_uuid}.jsonl"
            jsonl_path.parent.mkdir(parents=True, exist_ok=True)
            events = [
                {"type": "user", "uuid": "u-1", "message": {"content": "hi"},
                 "cwd": str(cwd_dir), "timestamp": "2026-01-01T00:00:00Z"},
                {"type": "assistant", "uuid": "a-1", "message": {
                    "content": [{"type": "text", "text": "hello!"}],
                    "stop_reason": "end_turn",
                }, "timestamp": "2026-01-01T00:00:01Z"},
            ]
            jsonl_path.write_text("\n".join(json.dumps(e) for e in events) + "\n")

        def send_enter(self): pass
        def send_ctrl_c(self): self._alive = False
        def send_esc(self): pass
        def isalive(self): return self._alive
        def terminate(self, *, force=False): self._alive = False

        @property
        def pid(self): return 0

    # Patch the symbol the adapter imported (PtyRunner) — it dataclass-binds
    # at construct time so we patch the module-level name.
    original_pty = adapter_module.PtyRunner
    original_pre = adapter_module._PRE_ENTER_DELAY_S
    original_jsonl_timeout = adapter_module._JSONL_APPEAR_TIMEOUT_S
    adapter_module.PtyRunner = FakePty  # type: ignore[assignment]
    adapter_module._PRE_ENTER_DELAY_S = 0.0  # type: ignore[assignment]
    adapter_module._JSONL_APPEAR_TIMEOUT_S = 5.0  # type: ignore[assignment]

    claude_uuid = "11111111-1111-1111-1111-111111111111"
    session_id = stable_claude_session_id("conn_x", claude_uuid)

    notifs: list[tuple[str, dict[str, Any]]] = []

    async def sink(method, params):
        notifs.append((method, params))

    adapter = ClaudeAdapter(projects_dir=projects, notification_sink=sink, claude_bin="echo")
    adapter._sessions[session_id] = _SessionRuntime(
        claude_uuid=claude_uuid, session_id=session_id, cwd=str(cwd_dir)
    )

    try:
        async def _exercise() -> dict[str, Any]:
            result = await adapter.start_turn({
                "sessionId": session_id,
                "externalSessionId": claude_uuid,
                "content": "hi",
            })
            # Wait for background drive task to finish (it pushes
            # session.updated as its last notification).
            for _ in range(80):
                if any(m == "session.updated" for m, _ in notifs):
                    break
                await asyncio.sleep(0.05)
            return result
        result = asyncio.run(_exercise())
    finally:
        adapter_module.PtyRunner = original_pty
        adapter_module._PRE_ENTER_DELAY_S = original_pre
        adapter_module._JSONL_APPEAR_TIMEOUT_S = original_jsonl_timeout

    assert result["turnId"] == "u-1"
    methods = [n[0] for n in notifs]
    assert "timeline.itemUpsert" in methods
    assert "session.updated" in methods
    types_emitted = [n[1]["item"]["type"] for n in notifs if n[0] == "timeline.itemUpsert"]
    assert "turn.start" in types_emitted
    assert "message" in types_emitted
    assert "turn.end" in types_emitted


def test_start_turn_tags_user_message_with_client_message_id(tmp_path: Path) -> None:
    from connector.claude import adapter as adapter_module

    cwd_dir = tmp_path / "work"
    cwd_dir.mkdir()
    projects = tmp_path / "projects"

    class FakePty:
        def __init__(self):
            self._alive = True

        def spawn(self, cmd, args, *, cwd=None, env=None, dimensions=None):
            jsonl_path = projects / encode_cwd(str(cwd_dir)) / f"{claude_uuid}.jsonl"
            jsonl_path.parent.mkdir(parents=True, exist_ok=True)
            events = [
                {
                    "type": "user",
                    "uuid": "u-1",
                    "message": {"content": "hi"},
                    "cwd": str(cwd_dir),
                    "timestamp": "2026-01-01T00:00:00Z",
                },
                {
                    "type": "assistant",
                    "uuid": "a-1",
                    "message": {
                        "content": [{"type": "text", "text": "hello!"}],
                        "stop_reason": "end_turn",
                    },
                    "timestamp": "2026-01-01T00:00:01Z",
                },
            ]
            jsonl_path.write_text("\n".join(json.dumps(e) for e in events) + "\n")

        def send_enter(self): pass
        def send_ctrl_c(self): self._alive = False
        def send_esc(self): pass
        def isalive(self): return self._alive
        def terminate(self, *, force=False): self._alive = False

        @property
        def pid(self): return 0

    original_pty = adapter_module.PtyRunner
    original_pre = adapter_module._PRE_ENTER_DELAY_S
    original_jsonl_timeout = adapter_module._JSONL_APPEAR_TIMEOUT_S
    adapter_module.PtyRunner = FakePty  # type: ignore[assignment]
    adapter_module._PRE_ENTER_DELAY_S = 0.0  # type: ignore[assignment]
    adapter_module._JSONL_APPEAR_TIMEOUT_S = 5.0  # type: ignore[assignment]

    claude_uuid = "22222222-2222-2222-2222-222222222222"
    session_id = stable_claude_session_id("conn_x", claude_uuid)
    notifs: list[tuple[str, dict[str, Any]]] = []

    async def sink(method, params):
        notifs.append((method, params))

    adapter = ClaudeAdapter(projects_dir=projects, notification_sink=sink, claude_bin="echo")
    adapter._sessions[session_id] = _SessionRuntime(
        claude_uuid=claude_uuid, session_id=session_id, cwd=str(cwd_dir)
    )

    try:
        async def _exercise() -> None:
            await adapter.start_turn(
                {
                    "sessionId": session_id,
                    "externalSessionId": claude_uuid,
                    "content": "hi",
                    "clientMessageId": "opt_claude",
                }
            )
            for _ in range(80):
                if any(m == "session.updated" for m, _ in notifs):
                    break
                await asyncio.sleep(0.05)

        asyncio.run(_exercise())
    finally:
        adapter_module.PtyRunner = original_pty
        adapter_module._PRE_ENTER_DELAY_S = original_pre
        adapter_module._JSONL_APPEAR_TIMEOUT_S = original_jsonl_timeout

    user_items = [
        params["item"]
        for method, params in notifs
        if method == "timeline.itemUpsert"
        and params["item"]["type"] == "message"
        and params["item"].get("role") == "user"
    ]
    assert user_items[-1]["source"]["clientMessageId"] == "opt_claude"
