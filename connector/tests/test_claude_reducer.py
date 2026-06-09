from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from connector.claude.reducer import ClaudeJsonlReducer


def _line(obj: dict[str, Any]) -> dict[str, Any]:
    return obj


def _reduce(events: list[dict[str, Any]]) -> Any:
    reducer = ClaudeJsonlReducer(session_id="sess_test", claude_uuid="uuid-test")
    return reducer.reduce_full(events)


def test_happy_turn_emits_user_message_assistant_message_turn_end() -> None:
    events = [
        _line({"type": "user", "uuid": "u1", "message": {"content": "Hi"}, "timestamp": "2026-01-01T00:00:00Z", "cwd": "/repo"}),
        _line({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "content": [{"type": "text", "text": "Hello!"}],
                "stop_reason": "end_turn",
            },
            "timestamp": "2026-01-01T00:00:01Z",
        }),
    ]
    result = _reduce(events)
    types = [(it["type"], it.get("role")) for it in result.timeline_items]
    assert types == [
        ("turn.start", None),
        ("message", "user"),
        ("message", "assistant"),
        ("turn.end", None),
    ]
    assert result.timeline_items[-1]["status"] == "done"
    assert result.timeline_items[-1]["content"]["stopReason"] == "end_turn"
    assert "title" not in result.session_update  # no ai-title event emitted
    assert result.session_update["cwd"] == "/repo"
    assert result.session_update["status"] == "idle"


def test_resume_injection_pair_is_filtered() -> None:
    events = [
        _line({"type": "user", "uuid": "u_real_1", "message": {"content": "Real first message"}}),
        _line({
            "type": "assistant",
            "uuid": "a_real_1",
            "message": {"content": [{"type": "text", "text": "OK"}], "stop_reason": "end_turn"},
        }),
        # Resume injection — must be filtered with the immediately-following
        # stop_sequence assistant.
        _line({"type": "user", "uuid": "u_inj", "message": {"content": "Continue from where you left off."}}),
        _line({
            "type": "assistant",
            "uuid": "a_inj",
            "message": {
                "content": [{"type": "text", "text": "No response requested."}],
                "stop_reason": "stop_sequence",
            },
        }),
        # Real follow-up.
        _line({"type": "user", "uuid": "u_real_2", "message": {"content": "Continue please"}}),
        _line({
            "type": "assistant",
            "uuid": "a_real_2",
            "message": {"content": [{"type": "text", "text": "Sure"}], "stop_reason": "end_turn"},
        }),
    ]
    result = _reduce(events)
    user_texts = [
        it["content"]["text"]
        for it in result.timeline_items
        if it["type"] == "message" and it["role"] == "user"
    ]
    assert user_texts == ["Real first message", "Continue please"]
    assistant_texts = [
        it["content"]["text"]
        for it in result.timeline_items
        if it["type"] == "message" and it["role"] == "assistant"
    ]
    assert assistant_texts == ["OK", "Sure"]


def test_reject_injection_text_is_filtered() -> None:
    events = [
        _line({"type": "user", "uuid": "u1", "message": {"content": "Run rm please"}}),
        _line({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "content": [{"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "rm /tmp/x"}}],
                "stop_reason": "tool_use",
            },
        }),
        _line({
            "type": "user",
            "uuid": "u_reject",
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": "tu1", "is_error": True, "content": "User rejected tool use"},
                ]
            },
        }),
        # The post-rejection injection — must be filtered.
        _line({
            "type": "user",
            "uuid": "u_inject",
            "message": {
                "content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]
            },
        }),
    ]
    result = _reduce(events)
    user_msgs = [
        it for it in result.timeline_items if it["type"] == "message" and it["role"] == "user"
    ]
    # Only the real user prompt — both the tool_result event and the
    # injection event are filtered out of user messages.
    assert len(user_msgs) == 1
    assert user_msgs[0]["content"]["text"] == "Run rm please"

    tool_items = [it for it in result.timeline_items if it["type"] == "tool"]
    assert len(tool_items) == 1
    # Task 5: rejection by user gets a dedicated `cancelled` status (was
    # `failed` in Task 3/4). Approval metadata lands in content.approval.
    assert tool_items[0]["status"] == "cancelled"
    assert tool_items[0]["content"]["isError"] is True
    assert tool_items[0]["content"]["approval"]["status"] == "rejected"
    assert "User rejected tool use" in tool_items[0]["content"]["output"]


def test_tool_use_bash_maps_to_command_with_output() -> None:
    events = [
        _line({"type": "user", "uuid": "u1", "message": {"content": "Check"}}),
        _line({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "tu_b",
                    "name": "Bash",
                    "input": {"command": "pwd", "description": "Print working directory"},
                }],
                "stop_reason": "tool_use",
            },
        }),
        _line({
            "type": "user",
            "uuid": "u_tr",
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": "tu_b", "content": "/repo\n"}
                ]
            },
        }),
        _line({
            "type": "assistant",
            "uuid": "a2",
            "message": {"content": [{"type": "text", "text": "Done"}], "stop_reason": "end_turn"},
        }),
    ]
    result = _reduce(events)
    tools = [it for it in result.timeline_items if it["type"] == "tool"]
    assert len(tools) == 1
    assert tools[0]["content"]["kind"] == "command"
    assert tools[0]["content"]["command"] == "pwd"
    assert tools[0]["content"]["output"] == "/repo\n"
    assert tools[0]["status"] == "done"
    # turn.end follows
    assert result.timeline_items[-1]["type"] == "turn.end"


def test_tool_use_edit_maps_to_file_change_with_diff() -> None:
    events = [
        _line({"type": "user", "uuid": "u1", "message": {"content": "Refactor"}}),
        _line({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "tu_e",
                    "name": "Edit",
                    "input": {"file_path": "/repo/x.py", "old_string": "foo", "new_string": "bar"},
                }],
                "stop_reason": "tool_use",
            },
        }),
        _line({
            "type": "user",
            "uuid": "u_tr",
            "message": {
                "content": [{"type": "tool_result", "tool_use_id": "tu_e", "content": "File updated"}]
            },
        }),
    ]
    result = _reduce(events)
    tools = [it for it in result.timeline_items if it["type"] == "tool"]
    assert tools[0]["content"]["kind"] == "file_change"
    change = tools[0]["content"]["changes"][0]
    assert change["path"] == "/repo/x.py"
    assert change["action"] == "edit"
    assert "foo" in change["diff"] and "bar" in change["diff"]


def test_todowrite_becomes_system_plan_item() -> None:
    events = [
        _line({"type": "user", "uuid": "u1", "message": {"content": "Plan it"}}),
        _line({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "tu_td",
                    "name": "TodoWrite",
                    "input": {"todos": [{"content": "step 1", "status": "pending"}]},
                }],
                "stop_reason": "tool_use",
            },
        }),
        _line({
            "type": "user",
            "uuid": "u_tr",
            "message": {
                "content": [{"type": "tool_result", "tool_use_id": "tu_td", "content": "OK"}]
            },
        }),
    ]
    result = _reduce(events)
    plans = [it for it in result.timeline_items if it["type"] == "system"]
    assert len(plans) == 1
    assert plans[0]["content"]["kind"] == "plan"
    assert plans[0]["content"]["todos"] == [{"content": "step 1", "status": "pending"}]


def test_mcp_tool_maps_to_mcp_kind() -> None:
    events = [
        _line({"type": "user", "uuid": "u1", "message": {"content": "Search docs"}}),
        _line({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "id": "tu_m",
                    "name": "mcp__langfuse-docs__searchLangfuseDocs",
                    "input": {"query": "tracing"},
                }],
                "stop_reason": "tool_use",
            },
        }),
    ]
    result = _reduce(events)
    tools = [it for it in result.timeline_items if it["type"] == "tool"]
    assert tools[0]["content"]["kind"] == "mcp"
    assert tools[0]["content"]["server"] == "langfuse-docs"
    assert tools[0]["content"]["tool"] == "searchLangfuseDocs"


def test_internal_event_types_are_ignored() -> None:
    events = [
        _line({"type": "queue-operation", "operation": "enqueue"}),
        _line({"type": "attachment", "attachment": {"foo": "bar"}}),
        _line({"type": "file-history-snapshot"}),
        _line({"type": "last-prompt"}),
        _line({"type": "user", "uuid": "u1", "message": {"content": "real"}}),
        _line({
            "type": "assistant",
            "uuid": "a1",
            "message": {"content": [{"type": "text", "text": "ok"}], "stop_reason": "end_turn"},
        }),
    ]
    result = _reduce(events)
    types_seen = {it["type"] for it in result.timeline_items}
    assert types_seen == {"turn.start", "message", "turn.end"}


def test_ai_title_and_permission_mode_land_in_session_update() -> None:
    events = [
        _line({"type": "permission-mode", "permissionMode": "bypassPermissions"}),
        _line({"type": "ai-title", "aiTitle": "First-pass draft"}),
        _line({"type": "user", "uuid": "u1", "message": {"content": "hi"}, "cwd": "/work"}),
        _line({
            "type": "assistant",
            "uuid": "a1",
            "message": {"content": [{"type": "text", "text": "yo"}], "stop_reason": "end_turn"},
        }),
        _line({"type": "custom-title", "customTitle": "Custom name wins"}),
    ]
    result = _reduce(events)
    assert result.session_update["title"] == "Custom name wins"
    assert result.session_update["permissionMode"] == "bypassPermissions"
    assert result.session_update["cwd"] == "/work"


def test_thinking_emits_separate_system_item() -> None:
    events = [
        _line({"type": "user", "uuid": "u1", "message": {"content": "ponder"}}),
        _line({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "content": [
                    {"type": "thinking", "thinking": "let me consider..."},
                    {"type": "text", "text": "Here is my answer"},
                ],
                "stop_reason": "end_turn",
            },
        }),
    ]
    result = _reduce(events)
    types = [(it["type"], it.get("content", {}).get("kind") or it.get("role")) for it in result.timeline_items]
    assert ("system", "reasoning") in types
    # Reasoning appears before the assistant message.
    sys_idx = next(i for i, it in enumerate(result.timeline_items) if it["type"] == "system")
    msg_idx = next(i for i, it in enumerate(result.timeline_items) if it["type"] == "message" and it["role"] == "assistant")
    assert sys_idx < msg_idx


def test_unclosed_turn_stays_running() -> None:
    events = [
        _line({"type": "user", "uuid": "u1", "message": {"content": "Run it"}}),
        _line({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "content": [{"type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "sleep 10"}}],
                "stop_reason": "tool_use",
            },
        }),
        # No tool_result, no closing assistant — turn is mid-flight.
    ]
    result = _reduce(events)
    turn_ends = [it for it in result.timeline_items if it["type"] == "turn.end"]
    assert turn_ends == []
    assert result.session_update["status"] == "running"


def test_user_message_can_carry_client_message_id() -> None:
    reducer = ClaudeJsonlReducer(session_id="sess_test", claude_uuid="uuid-test")
    reducer.register_client_message(client_message_id="opt_1", text="Hello")

    result = reducer.reduce_full(
        [
            _line({"type": "user", "uuid": "u1", "message": {"content": "Hello"}}),
        ]
    )

    user = next(item for item in result.timeline_items if item["type"] == "message")
    assert user["source"]["clientMessageId"] == "opt_1"


def test_interrupt_injection_closes_open_turn_as_interrupted() -> None:
    events = [
        _line({"type": "user", "uuid": "u1", "message": {"content": "Run forever"}}),
        _line(
            {
                "type": "user",
                "uuid": "u_interrupt",
                "message": {"content": "[Request interrupted by user]"},
            }
        ),
    ]

    result = _reduce(events)

    user_msgs = [
        item for item in result.timeline_items if item["type"] == "message" and item["role"] == "user"
    ]
    turn_end = result.timeline_items[-1]
    assert len(user_msgs) == 1
    assert turn_end["type"] == "turn.end"
    assert turn_end["status"] == "interrupted"
    assert turn_end["content"] == {"stopReason": "interrupted", "result": "interrupted"}
    assert turn_end["source"]["event"] == "user"
    assert result.session_update["status"] == "idle"


def test_real_jsonl_file_reduces_without_crashing(tmp_path: Path) -> None:
    """Smoke test against a real session file from the user's machine.
    Skipped when no Claude session dir exists locally."""
    candidates = list((Path.home() / ".claude" / "projects").glob("*/*.jsonl"))
    if not candidates:
        return  # nothing to do on a clean machine
    real = max(candidates, key=lambda p: p.stat().st_size)  # pick a big one
    from connector.claude.watcher import iter_jsonl_events

    reducer = ClaudeJsonlReducer(session_id="sess_smoke", claude_uuid=real.stem)
    result = reducer.reduce_full(iter_jsonl_events(real))
    # At minimum a session_update; timeline may be empty for purely-internal sessions.
    assert result.session_update is not None
    assert result.session_update["runtime"] == "claude"
    # Spot-check there's no malformed item.
    for item in result.timeline_items:
        assert "id" in item and "sessionId" in item and "type" in item
        assert item["sessionId"] == "sess_smoke"
        json.dumps(item, ensure_ascii=False)  # must serialize cleanly
