from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from connector.claude.history_adapter import ClaudeHistoryAdapter
from connector.claude.path_utils import stable_claude_session_id
from connector.sync_state import SqliteSyncStateStore


@dataclass
class FakeSessionInfo:
    session_id: str
    summary: str
    last_modified: int
    file_size: int
    cwd: str
    created_at: int
    custom_title: str | None = None


@dataclass
class FakeSessionMessage:
    type: str
    uuid: str
    session_id: str
    message: dict[str, Any]


class FakeHistorySdk:
    sessions = [
        FakeSessionInfo(
            session_id="11111111-1111-1111-1111-111111111111",
            summary="Run tests",
            last_modified=1_765_000_000_000,
            file_size=4096,
            cwd="/repo",
            created_at=1_765_000_000_000,
        )
    ]
    messages = [
        FakeSessionMessage(
            type="user",
            uuid="u1",
            session_id="11111111-1111-1111-1111-111111111111",
            message={"role": "user", "content": [{"type": "text", "text": "Run tests"}]},
        ),
        FakeSessionMessage(
            type="assistant",
            uuid="a1",
            session_id="11111111-1111-1111-1111-111111111111",
            message={
                "id": "msg_a1",
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "I'll run them."},
                    {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "pytest -q"}},
                ],
            },
        ),
        FakeSessionMessage(
            type="user",
            uuid="u_tool_result",
            session_id="11111111-1111-1111-1111-111111111111",
            message={
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "passed"}],
            },
        ),
    ]

    @classmethod
    def list_sessions(cls, *, limit=None, offset=0):
        values = cls.sessions[offset:]
        return values if limit is None else values[:limit]

    @classmethod
    def get_session_messages(cls, session_id, directory=None):
        return [msg for msg in cls.messages if msg.session_id == session_id]

    @classmethod
    def get_session_info(cls, session_id, directory=None):
        return next(session for session in cls.sessions if session.session_id == session_id)


def _messages_with_extra_turn() -> list[FakeSessionMessage]:
    return [
        *FakeHistorySdk.messages,
        FakeSessionMessage(
            type="user",
            uuid="u2",
            session_id="11111111-1111-1111-1111-111111111111",
            message={"role": "user", "content": [{"type": "text", "text": "Again"}]},
        ),
        FakeSessionMessage(
            type="assistant",
            uuid="a2",
            session_id="11111111-1111-1111-1111-111111111111",
            message={
                "id": "msg_a2",
                "role": "assistant",
                "content": [{"type": "text", "text": "Done."}],
            },
        ),
    ]


def test_sdk_history_sync_emits_session_update_and_timeline_sync() -> None:
    adapter = ClaudeHistoryAdapter(sdk_module=FakeHistorySdk)
    received: list[dict[str, Any]] = []

    async def sink(notifications: list[dict[str, Any]]) -> None:
        received.extend(notifications)

    result = asyncio.run(adapter.sync_existing_sessions("conn_x", notification_sink=sink))
    session_id = stable_claude_session_id("conn_x", FakeHistorySdk.sessions[0].session_id)

    assert result["threads"] == [session_id]
    assert result["skippedThreads"] == []
    assert [item["method"] for item in received] == ["session.updated", "timeline.sync"]
    assert received[0]["params"]["title"] == "Run tests"
    assert received[0]["params"]["cwd"] == "/repo"

    timeline = received[1]["params"]["items"]
    assert [item["type"] for item in timeline] == [
        "turn.start",
        "message",
        "message",
        "turn.end",
    ]
    assert timeline[1]["role"] == "user"
    assert timeline[0]["source"]["itemType"] == "turn.start"
    assert timeline[-1]["source"]["itemType"] == "turn.end"
    assert timeline[2]["content"]["text"] == "I'll run them."
    assert timeline[-1]["content"]["result"] == "completed"


def test_sdk_history_sync_skips_unchanged_sessions() -> None:
    adapter = ClaudeHistoryAdapter(sdk_module=FakeHistorySdk)

    first = asyncio.run(adapter.sync_existing_sessions("conn_x"))
    second = asyncio.run(adapter.sync_existing_sessions("conn_x"))

    assert len(first["backendNotifications"]) == 2
    assert second["backendNotifications"] == []
    assert second["skippedThreads"] == [FakeHistorySdk.sessions[0].session_id]


def test_sdk_history_sync_after_cursor_emits_incremental_item_upserts() -> None:
    class GrowingHistorySdk(FakeHistorySdk):
        messages = list(FakeHistorySdk.messages)

    adapter = ClaudeHistoryAdapter(sdk_module=GrowingHistorySdk)

    first = asyncio.run(adapter.sync_existing_sessions("conn_x"))
    assert [item["method"] for item in first["backendNotifications"]] == ["session.updated", "timeline.sync"]

    GrowingHistorySdk.messages = _messages_with_extra_turn()
    GrowingHistorySdk.sessions = [
        FakeSessionInfo(
            session_id=FakeHistorySdk.sessions[0].session_id,
            summary="Run tests",
            last_modified=1_765_000_001_000,
            file_size=8192,
            cwd="/repo",
            created_at=1_765_000_000_000,
        )
    ]

    second = asyncio.run(adapter.sync_existing_sessions("conn_x"))

    methods = [item["method"] for item in second["backendNotifications"]]
    assert "timeline.sync" not in methods
    assert methods[0] == "session.updated"
    assert methods[1:] == ["timeline.itemUpsert"] * 4
    assert second["backendNotifications"][1]["params"]["item"]["type"] == "turn.start"
    assert second["backendNotifications"][2]["params"]["item"]["role"] == "user"
    assert second["backendNotifications"][-1]["params"]["item"]["type"] == "turn.end"


def test_sdk_history_sync_uses_persisted_cursor_after_restart(tmp_path) -> None:
    store = SqliteSyncStateStore(tmp_path / "connector-state.sqlite3")
    first_adapter = ClaudeHistoryAdapter(sdk_module=FakeHistorySdk, sync_state_store=store)
    second_adapter = ClaudeHistoryAdapter(sdk_module=FakeHistorySdk, sync_state_store=store)

    first = asyncio.run(first_adapter.sync_existing_sessions("conn_x"))
    second = asyncio.run(second_adapter.sync_existing_sessions("conn_x"))

    assert [item["method"] for item in first["backendNotifications"]] == ["session.updated", "timeline.sync"]
    assert second["backendNotifications"] == []
    assert second["skippedThreads"] == [FakeHistorySdk.sessions[0].session_id]


def test_sdk_history_sync_skips_active_external_session() -> None:
    adapter = ClaudeHistoryAdapter(sdk_module=FakeHistorySdk)

    result = asyncio.run(
        adapter.sync_existing_sessions(
            "conn_x",
            skip_external_session_ids={FakeHistorySdk.sessions[0].session_id},
        )
    )

    assert result["backendNotifications"] == []
    assert result["threads"] == []
    assert result["skippedThreads"] == [FakeHistorySdk.sessions[0].session_id]


def test_sdk_history_sync_session_tags_pending_client_message() -> None:
    adapter = ClaudeHistoryAdapter(sdk_module=FakeHistorySdk)

    result = asyncio.run(
        adapter.sync_session(
            {
                "sessionId": "sess_live",
                "externalSessionId": FakeHistorySdk.sessions[0].session_id,
                "cwd": "/repo",
                "pendingClientMessages": [
                    {
                        "clientMessageId": "opt_1",
                        "text": "Run tests",
                        "attachments": [{"fileId": "file_1", "name": "report.txt"}],
                    }
                ],
            }
        )
    )

    sync = next(item for item in result["backendNotifications"] if item["method"] == "timeline.sync")
    user = next(
        item
        for item in sync["params"]["items"]
        if item["type"] == "message" and item["role"] == "user"
    )
    assert user["source"]["clientMessageId"] == "opt_1"
    assert user["content"]["attachments"] == [{"fileId": "file_1", "name": "report.txt"}]


def test_sdk_history_sync_filters_incomplete_tool_calls() -> None:
    class IncompleteToolHistorySdk(FakeHistorySdk):
        messages = [
            FakeSessionMessage(
                type="user",
                uuid="u1",
                session_id=FakeHistorySdk.sessions[0].session_id,
                message={"role": "user", "content": [{"type": "text", "text": "Fetch docs"}]},
            ),
            FakeSessionMessage(
                type="assistant",
                uuid="a1",
                session_id=FakeHistorySdk.sessions[0].session_id,
                message={
                    "id": "msg_a1",
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "I'll fetch it."},
                        {
                            "type": "tool_use",
                            "id": "toolu_missing",
                            "name": "mcp__docs__get",
                            "input": {"path": "/overview"},
                        },
                    ],
                },
            ),
        ]

    result = asyncio.run(ClaudeHistoryAdapter(sdk_module=IncompleteToolHistorySdk).sync_existing_sessions("conn_x"))
    sync = next(item for item in result["backendNotifications"] if item["method"] == "timeline.sync")

    assert [item["type"] for item in sync["params"]["items"]] == [
        "turn.start",
        "message",
        "message",
        "turn.end",
    ]
    assert all(item["type"] != "tool" for item in sync["params"]["items"])


def test_sdk_history_sync_keeps_file_changes_but_filters_mcp_tools() -> None:
    class MixedToolHistorySdk(FakeHistorySdk):
        messages = [
            FakeSessionMessage(
                type="user",
                uuid="u1",
                session_id=FakeHistorySdk.sessions[0].session_id,
                message={"role": "user", "content": [{"type": "text", "text": "Update file and fetch docs"}]},
            ),
            FakeSessionMessage(
                type="assistant",
                uuid="a1",
                session_id=FakeHistorySdk.sessions[0].session_id,
                message={
                    "id": "msg_a1",
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
                            "name": "mcp__docs__get",
                            "input": {"path": "/overview"},
                        },
                    ],
                },
            ),
            FakeSessionMessage(
                type="user",
                uuid="u_results",
                session_id=FakeHistorySdk.sessions[0].session_id,
                message={
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "toolu_write", "content": "File written"},
                        {"type": "tool_result", "tool_use_id": "toolu_mcp", "content": "Docs result"},
                    ],
                },
            ),
            FakeSessionMessage(
                type="assistant",
                uuid="a2",
                session_id=FakeHistorySdk.sessions[0].session_id,
                message={
                    "id": "msg_a2",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Updated."}],
                },
            ),
        ]

    result = asyncio.run(ClaudeHistoryAdapter(sdk_module=MixedToolHistorySdk).sync_existing_sessions("conn_x"))
    sync = next(item for item in result["backendNotifications"] if item["method"] == "timeline.sync")
    tools = [item for item in sync["params"]["items"] if item["type"] == "tool"]

    assert len(tools) == 1
    assert tools[0]["content"]["kind"] == "file_change"
    assert tools[0]["content"]["toolName"] == "Write"
    assert tools[0]["content"]["result"] == "File written"
