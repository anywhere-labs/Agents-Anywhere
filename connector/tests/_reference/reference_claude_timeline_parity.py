from __future__ import annotations

from connector.claude.normalizers import ClaudeLiveNormalizer, ClaudeTranscriptNormalizer
from connector.claude.timeline_reducer import ClaudeTimelineReducer


def test_live_and_transcript_normalizers_reduce_to_same_timeline_items():
    raw_turn = [
        {
            "uuid": "evt_user",
            "session_id": "claude_sess_1",
            "timestamp": "2026-06-04T00:00:00Z",
            "message": {
                "id": "msg_user_1",
                "role": "user",
                "content": [{"type": "text", "text": "Run the tests"}],
            },
        },
        {
            "uuid": "evt_assistant",
            "session_id": "claude_sess_1",
            "timestamp": "2026-06-04T00:00:01Z",
            "message": {
                "id": "msg_assistant_1",
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "I'll run them."},
                    {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "pytest -q"}},
                ],
            },
        },
        {
            "uuid": "evt_assistant_duplicate_tool_use",
            "session_id": "claude_sess_1",
            "timestamp": "2026-06-04T00:00:01Z",
            "message": {
                "id": "msg_assistant_1",
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "pytest -q"}},
                ],
            },
        },
        {
            "uuid": "evt_tool_result",
            "session_id": "claude_sess_1",
            "timestamp": "2026-06-04T00:00:04Z",
            "message": {
                "id": "msg_user_tool_result",
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "249 passed"}],
            },
        },
    ]

    reducer = ClaudeTimelineReducer()
    live_items = reducer.reduce(
        session_id="sess_1",
        turn_id="turn_1",
        events=ClaudeLiveNormalizer().normalize(raw_turn),
    )
    transcript_items = reducer.reduce(
        session_id="sess_1",
        turn_id="turn_1",
        events=ClaudeTranscriptNormalizer().normalize(raw_turn),
    )

    assert [item["id"] for item in live_items] == [item["id"] for item in transcript_items]
    assert [item["type"] for item in live_items] == [item["type"] for item in transcript_items]
    assert [item["status"] for item in live_items] == [item["status"] for item in transcript_items]
    assert [item["role"] for item in live_items] == [item["role"] for item in transcript_items]
    assert [item["content"] for item in live_items] == [item["content"] for item in transcript_items]
    assert [item["orderSeq"] for item in live_items] == [item["orderSeq"] for item in transcript_items]

    tool_items = [item for item in live_items if item["type"] == "tool"]
    assert len(tool_items) == 1
    assert tool_items[0]["content"]["toolUseId"] == "toolu_1"
    assert tool_items[0]["content"]["kind"] == "command"
    assert tool_items[0]["content"]["command"] == "pytest -q"
    assert tool_items[0]["content"]["result"] == "249 passed"
    assert tool_items[0]["content"]["outputPreview"] == "249 passed"
    assert tool_items[0]["status"] == "done"


def test_claude_timeline_ids_are_stable_across_platform_session_ids():
    raw = [
        {
            "uuid": "evt_assistant",
            "session_id": "claude_sess_1",
            "timestamp": "2026-06-04T00:00:01Z",
            "message": {
                "id": "msg_assistant_1",
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "I'll run them."},
                    {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "pytest -q"}},
                ],
            },
        },
    ]
    events = ClaudeLiveNormalizer().normalize(raw)
    reducer = ClaudeTimelineReducer()

    first = reducer.reduce(session_id="sess_live", turn_id="turn_1", events=events)
    second = reducer.reduce(session_id="sess_history", turn_id="turn_1", events=events)

    assert [item["id"] for item in first] == [item["id"] for item in second]


def test_claude_file_and_mcp_tools_reduce_to_platform_tool_content():
    raw_turn = [
        {
            "uuid": "evt_write",
            "session_id": "claude_sess_1",
            "timestamp": "2026-06-04T00:00:01Z",
            "message": {
                "id": "msg_assistant_1",
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "toolu_write",
                        "name": "Write",
                        "input": {"file_path": "/repo/app.py", "content": "print('hi')\n"},
                    },
                    {
                        "type": "tool_use",
                        "id": "toolu_mcp",
                        "name": "mcp__browser__click",
                        "input": {"selector": "#send"},
                    },
                ],
            },
        },
        {
            "uuid": "evt_write_result",
            "session_id": "claude_sess_1",
            "timestamp": "2026-06-04T00:00:02Z",
            "message": {
                "id": "msg_tool_results",
                "role": "user",
                "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_write", "content": "File created"},
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_mcp",
                        "content": [{"type": "text", "text": "clicked"}],
                    },
                ],
            },
        },
    ]

    items = ClaudeTimelineReducer().reduce(
        session_id="sess_1",
        turn_id="turn_1",
        events=ClaudeLiveNormalizer().normalize(raw_turn),
    )

    tools = [item for item in items if item["type"] == "tool"]
    assert len(tools) == 2

    file_tool = next(item for item in tools if item["content"]["toolUseId"] == "toolu_write")
    assert file_tool["status"] == "done"
    assert file_tool["role"] == "tool"
    assert file_tool["content"]["kind"] == "file_change"
    assert file_tool["content"]["changes"] == [
        {
            "path": "/repo/app.py",
            "action": "add",
            "kind": {"type": "add"},
            "diff": "print('hi')\n",
        }
    ]
    assert file_tool["content"]["result"] == "File created"

    mcp_tool = next(item for item in tools if item["content"]["toolUseId"] == "toolu_mcp")
    assert mcp_tool["status"] == "done"
    assert mcp_tool["content"]["kind"] == "mcp"
    assert mcp_tool["content"]["server"] == "browser"
    assert mcp_tool["content"]["tool"] == "click"
    assert mcp_tool["content"]["arguments"] == {"selector": "#send"}
    assert mcp_tool["content"]["outputPreview"] == "clicked"


def test_claude_task_event_tools_are_filtered_from_live_and_transcript_timelines():
    raw_turn = [
        {
            "uuid": "evt_task_update",
            "session_id": "claude_sess_1",
            "timestamp": "2026-06-04T00:00:01Z",
            "message": {
                "id": "msg_task_update",
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "call_task_1",
                        "name": "TaskUpdate",
                        "input": {
                            "taskId": "13",
                            "status": "deleted",
                            "description": "obsolete task",
                        },
                    }
                ],
            },
        },
        {
            "uuid": "evt_task_update_result",
            "session_id": "claude_sess_1",
            "timestamp": "2026-06-04T00:00:02Z",
            "message": {
                "id": "msg_task_update_result",
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "call_task_1",
                        "content": "Updated task #13 deleted",
                    }
                ],
            },
        },
        {
            "uuid": "evt_assistant",
            "session_id": "claude_sess_1",
            "timestamp": "2026-06-04T00:00:03Z",
            "message": {
                "id": "msg_assistant_1",
                "role": "assistant",
                "content": [{"type": "text", "text": "Done."}],
            },
        },
    ]

    reducer = ClaudeTimelineReducer()
    live_items = reducer.reduce(
        session_id="sess_1",
        turn_id="turn_1",
        events=ClaudeLiveNormalizer().normalize(raw_turn),
    )
    transcript_items = reducer.reduce(
        session_id="sess_1",
        turn_id="turn_1",
        events=ClaudeTranscriptNormalizer().normalize(raw_turn),
    )

    assert [item["content"].get("text") for item in live_items] == ["Done."]
    assert [item["content"].get("text") for item in transcript_items] == ["Done."]
    assert all(item["type"] != "tool" for item in live_items)
    assert all(item["type"] != "tool" for item in transcript_items)
