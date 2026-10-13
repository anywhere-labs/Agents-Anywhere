from __future__ import annotations

from connector.runtimes.pi.projection import project_session


def entries() -> list[dict]:
    return [
        {
            "type": "message",
            "id": "u1",
            "parentId": None,
            "timestamp": "t",
            "message": {"role": "user", "content": "你好", "timestamp": 1},
        },
        {
            "type": "message",
            "id": "a1",
            "parentId": "u1",
            "timestamp": "t",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "先看文件"},
                    {
                        "type": "toolCall",
                        "id": "call_1",
                        "name": "bash",
                        "arguments": {"command": "ls -la"},
                    },
                    {"type": "text", "text": "看完了"},
                ],
                "model": "test-model",
                "provider": "test",
                "stopReason": "toolUse",
                "timestamp": 2,
            },
        },
        {
            "type": "message",
            "id": "r1",
            "parentId": "a1",
            "timestamp": "t",
            "message": {
                "role": "toolResult",
                "toolCallId": "call_1",
                "toolName": "bash",
                "content": [{"type": "text", "text": "total 0\n"}],
                "details": {"exitCode": 0},
                "isError": False,
                "timestamp": 3,
            },
        },
    ]


def test_projection_shapes() -> None:
    items = project_session(entries(), session_id="sess-1", external_session_id="/tmp/s.jsonl")
    types = [item.type for item in items]
    assert types == [
        "turn.start",
        "message",
        "system",
        "tool",
        "message",
        "turn.end",
    ]
    user_item = items[1]
    assert user_item.role == "user"
    assert user_item.content["text"] == "你好"
    reasoning = items[2]
    assert reasoning.content == {"kind": "reasoning", "text": "先看文件"}
    tool = items[3]
    assert tool.status == "done"
    assert tool.content["kind"] == "command"
    assert tool.content["command"] == "ls -la"
    assert tool.content["output"] == "total 0\n"
    assert tool.content["exitCode"] == 0
    assistant = items[4]
    assert assistant.content["kind"] == "markdown"
    assert assistant.content["text"] == "看完了"


def test_projection_ids_and_order_are_stable() -> None:
    first = project_session(entries(), session_id="sess-1", external_session_id="/tmp/s.jsonl")
    second = project_session(entries(), session_id="sess-1", external_session_id="/tmp/s.jsonl")
    assert [item.id for item in first] == [item.id for item in second]
    assert [item.order_seq for item in first] == list(range(1, len(first) + 1))
    for item in first:
        assert item.session_id == "sess-1"
        assert item.content_hash.startswith("sha256:")


def test_client_message_id_attaches_to_user_message() -> None:
    """The platform dedupes optimistic sends by this metadata id."""

    items = project_session(
        entries(),
        session_id="s",
        external_session_id="/tmp/s.jsonl",
        client_messages=[("你好", "cm-1")],
    )
    user_item = next(item for item in items if item.role == "user")
    assert user_item.source["clientMessageId"] == "cm-1"


def test_client_message_id_lookup_is_idempotent() -> None:
    """Repeated projections must still find the id; the sync re-projects."""

    records = [
        {
            "type": "message",
            "id": "u1",
            "parentId": None,
            "timestamp": "t",
            "message": {"role": "user", "content": "继续", "timestamp": 1},
        },
        {
            "type": "message",
            "id": "u2",
            "parentId": "u1",
            "timestamp": "t",
            "message": {"role": "user", "content": "继续", "timestamp": 2},
        },
    ]
    client_messages = [("继续", "cm-1"), ("继续", "cm-2")]
    first = project_session(
        records,
        session_id="s",
        external_session_id="/tmp/s.jsonl",
        client_messages=client_messages,
    )
    second = project_session(
        records,
        session_id="s",
        external_session_id="/tmp/s.jsonl",
        client_messages=client_messages,
    )
    pick = lambda items: [
        item.source.get("clientMessageId") for item in items if item.role == "user"
    ]
    assert pick(first) == pick(second), "a second projection must not lose ids"
    # Identical texts take the most recent id (the in-flight optimistic send).
    assert pick(first) == ["cm-2", "cm-2"]


def test_compaction_marker() -> None:
    records = [
        {
            "type": "compaction",
            "id": "c1",
            "parentId": None,
            "timestamp": "t",
            "summary": "earlier context",
            "firstKeptEntryId": "c1",
        },
    ]
    items = project_session(records, session_id="s", external_session_id="/tmp/s.jsonl")
    assert len(items) == 1
    assert items[0].type == "marker"
    assert items[0].content["kind"] == "compact"
