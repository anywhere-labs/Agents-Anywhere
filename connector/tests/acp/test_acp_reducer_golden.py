from __future__ import annotations

from connector.acp.reducer import AcpTimelineReducer
from tests.contract.helpers import assert_timeline_item_schema, assert_turn_lifecycle


def test_reducer_basic_text_turn_lifecycle() -> None:
    reducer = AcpTimelineReducer(runtime="gemini")
    start = reducer.turn_start(
        session_id="sess_1",
        turn_id="turn_1",
        external_session_id="acp_1",
        content="Reply with PONG",
        client_message_id="cm_1",
    )
    chunk = reducer.reduce_session_update(
        session_id="sess_1",
        turn_id="turn_1",
        external_session_id="acp_1",
        update={
            "sessionUpdate": "agent_message_chunk",
            "messageId": "msg_1",
            "content": {"type": "text", "text": "PONG"},
        },
    )
    end = reducer.turn_end(
        session_id="sess_1",
        turn_id="turn_1",
        external_session_id="acp_1",
        stop_reason="end_turn",
    )
    items = [*start.timeline_items, *chunk.timeline_items, *end.timeline_items]
    for item in items:
        assert_timeline_item_schema(item, runtime="gemini")
    assert_turn_lifecycle(items)
    assert start.timeline_items[1]["role"] == "user"
    assert start.timeline_items[1]["source"]["clientMessageId"] == "cm_1"
    assistant = [i for i in items if i.get("role") == "assistant"]
    assert assistant
    assert assistant[0]["content"]["text"] == "PONG"
    assert end.session_update is not None
    assert end.session_update["status"] == "idle"


def test_reducer_tool_and_permission() -> None:
    reducer = AcpTimelineReducer(runtime="cursor")
    reducer.turn_start(
        session_id="sess_1",
        turn_id="turn_1",
        external_session_id="acp_1",
        content="run ls",
    )
    tool = reducer.reduce_session_update(
        session_id="sess_1",
        turn_id="turn_1",
        external_session_id="acp_1",
        update={
            "sessionUpdate": "tool_call",
            "toolCallId": "call_1",
            "title": "Shell",
            "kind": "execute",
            "status": "pending",
            "rawInput": {"command": "ls"},
        },
    )
    assert tool.timeline_items[0]["type"] == "tool"
    assert tool.timeline_items[0]["content"]["kind"] == "command"
    assert_timeline_item_schema(tool.timeline_items[0], runtime="cursor")

    perm = reducer.reduce_permission_request(
        session_id="sess_1",
        turn_id="turn_1",
        external_session_id="acp_1",
        request_id=42,
        params={
            "toolCall": {"toolCallId": "call_1", "title": "Shell", "kind": "execute"},
            "options": [
                {"optionId": "allow-once", "name": "Allow", "kind": "allow_once"},
                {"optionId": "reject-once", "name": "Reject", "kind": "reject_once"},
            ],
        },
    )
    assert perm.approval is not None
    assert perm.approval["source"]["runtime"] == "cursor"
    assert "approve" in perm.approval["choices"]
    assert perm.timeline_items[0]["status"] == "waiting_approval"
