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
    assert len(tool_items) == 2
    assert tool_items[0]["content"]["toolUseId"] == "toolu_1"
    assert tool_items[0]["content"]["kind"] == "command"
    assert tool_items[1]["content"]["toolUseId"] == "toolu_1"
    assert tool_items[1]["content"]["result"] == "249 passed"
