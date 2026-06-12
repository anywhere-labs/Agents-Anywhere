from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

from connector.codex.adapter import (
    EXISTING_SYNC_CHANGED_THREAD_TIMEOUT_SECONDS,
    EXISTING_SYNC_SCAN_TIMEOUT_SECONDS,
    CodexAdapter,
    stable_session_id,
)
from connector.codex.history import read_timeline_history, read_tool_history
from connector.codex.reducer import TimelineReducer
from connector.codex.rpc import APP_SERVER_STREAM_LIMIT, JsonRpcStdioClient
from connector.sync_state import SqliteSyncStateStore


class FakeCodexRpc:
    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, Any] | None]] = []
        self.responses: list[tuple[str | int, dict[str, Any] | None]] = []
        self.started = False
        self.handler: Callable[[dict[str, Any]], Awaitable[None]] | None = None

    async def start(self, handler: Callable[[dict[str, Any]], Awaitable[None]]) -> None:
        self.started = True
        self.handler = handler

    async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.requests.append((method, params))
        if method == "thread/start":
            return {"thread": {"id": "thr_1", "status": {"type": "loaded"}}}
        if method == "thread/list":
            return {"data": [{"id": "thr_existing", "path": "/tmp/rollout-thr_existing.jsonl", "updatedAt": 1779291318}]}
        if method == "thread/resume":
            return {"thread": {"id": (params or {}).get("threadId"), "status": {"type": "loaded"}}}
        if method == "thread/read":
            return {
                "thread": {
                    "id": (params or {}).get("threadId"),
                    "title": "Demo thread",
                    "cwd": "/repo",
                    "status": {"type": "idle"},
                    "turns": [
                        {
                            "id": "turn_1",
                            "status": "completed",
                            "input": [{"type": "text", "text": "hello"}],
                            "items": [
                                {
                                    "id": "item_1",
                                    "type": "userMessage",
                                    "text": "hello",
                                    "status": "completed",
                                },
                                {
                                    "id": "item_2",
                                    "type": "agentMessage",
                                    "text": "hi",
                                    "status": "completed",
                                },
                            ],
                        }
                    ],
                }
            }
        if method == "turn/start":
            return {"turn": {"id": "turn_2", "status": "inProgress"}}
        return {}

    async def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self.requests.append((method, params))

    async def respond(self, request_id: str | int, result: dict[str, Any] | None = None) -> None:
        self.responses.append((request_id, result))


class InterruptThreadNotFoundRpc(FakeCodexRpc):
    async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if method == "turn/interrupt":
            raise RuntimeError(json.dumps({"code": -32600, "message": "thread not found: thr_missing"}))
        return await super().request(method, params)


def test_stdio_client_stream_limit_is_large_enough_for_codex_jsonl() -> None:
    assert APP_SERVER_STREAM_LIMIT >= 64 * 1024 * 1024


def test_stdio_client_preserves_numeric_server_request_ids() -> None:
    client = JsonRpcStdioClient(command=["codex"])
    client._server_request_ids.add(0)  # noqa: SLF001

    assert client._response_id_for("0") == 0  # noqa: SLF001
    assert 0 not in client._server_request_ids  # noqa: SLF001


class FakeStdin:
    def __init__(self) -> None:
        self.chunks: list[bytes] = []

    def write(self, chunk: bytes) -> None:
        self.chunks.append(chunk)

    async def drain(self) -> None:
        return None


class FakeProcess:
    def __init__(self) -> None:
        self.stdin = FakeStdin()


async def _exercise_stdio_client_includes_empty_params() -> None:
    client = JsonRpcStdioClient(command=["codex"])
    client.process = FakeProcess()  # type: ignore[assignment]
    loop = asyncio.get_running_loop()
    loop.call_soon(lambda: client._pending[1].set_result({}))  # noqa: SLF001

    await client.request("account/read")
    await client.notify("initialized")

    stdin = client.process.stdin
    assert isinstance(stdin, FakeStdin)
    request_payload = json.loads(stdin.chunks[0])
    notify_payload = json.loads(stdin.chunks[1])
    assert request_payload["params"] == {}
    assert notify_payload["params"] == {}


def test_stdio_client_includes_empty_params_for_no_arg_messages() -> None:
    asyncio.run(_exercise_stdio_client_includes_empty_params())


def test_stdio_client_ignores_response_for_cancelled_request() -> None:
    client = JsonRpcStdioClient(command=["codex"])
    loop = asyncio.new_event_loop()
    try:
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        future.cancel()

        client._settle_pending_future(future, {"id": 1, "result": {"ok": True}})  # noqa: SLF001

        assert future.cancelled()
    finally:
        loop.close()


def test_reducer_maps_codex_turn_and_message_notifications() -> None:
    reducer = TimelineReducer()
    reducer.bind_session("sess_1", "thr_1")

    started = reducer.reduce_notification(
        {
            "method": "turn/started",
            "params": {"threadId": "thr_1", "turnId": "turn_1", "turn": {"input": "hello"}},
        }
    )
    assert started.session_update == {
        "sessionId": "sess_1",
        "runtime": "codex",
        "externalSessionId": "thr_1",
        "status": "running",
        "sourceObservedAt": started.session_update["sourceObservedAt"],
    }
    assert started.timeline_items[0]["type"] == "turn.start"
    assert started.timeline_items[0]["sessionId"] == "sess_1"
    assert started.timeline_items[0]["source"]["runtime"] == "codex"

    delta = reducer.reduce_notification(
        {
            "method": "item/agentMessage/delta",
            "params": {"threadId": "thr_1", "turnId": "turn_1", "itemId": "item_1", "delta": "hi"},
        }
    )
    assert delta.timeline_items[0]["type"] == "message"
    assert delta.timeline_items[0]["content"]["text"] == "hi"

    completed = reducer.reduce_notification(
        {
            "method": "turn/completed",
            "params": {"threadId": "thr_1", "turnId": "turn_1", "turn": {"status": "completed"}},
        }
    )
    assert completed.session_update["status"] == "idle"
    assert [item["type"] for item in completed.timeline_items] == ["turn.start", "turn.end"]


def test_reducer_keeps_agent_delta_items_separate_by_item_id() -> None:
    reducer = TimelineReducer()
    reducer.bind_session("sess_1", "thr_1")

    first = reducer.reduce_notification(
        {
            "method": "item/agentMessage/delta",
            "params": {"threadId": "thr_1", "turnId": "turn_1", "itemId": "msg_first", "delta": "before tool"},
        }
    ).timeline_items[0]
    second = reducer.reduce_notification(
        {
            "method": "item/agentMessage/delta",
            "params": {"threadId": "thr_1", "turnId": "turn_1", "itemId": "msg_second", "delta": "after tool"},
        }
    ).timeline_items[0]

    assert first["id"] != second["id"]
    assert first["content"]["text"] == "before tool"
    assert second["content"]["text"] == "after tool"


def test_reducer_keeps_live_and_snapshot_message_ids_distinct() -> None:
    reducer = TimelineReducer()
    reducer.bind_session("sess_1", "thr_1")

    live_user = reducer.reduce_notification(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "itemId": "uuid-user",
                "item": {
                    "id": "uuid-user",
                    "type": "userMessage",
                    "content": [{"type": "input_text", "text": "你是谁"}],
                },
            },
        }
    )
    live_assistant = reducer.reduce_notification(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "itemId": "msg_1",
                "item": {
                    "id": "msg_1",
                    "type": "agentMessage",
                    "text": "我是 Codex",
                },
            },
        }
    )

    snapshot = reducer.reduce_thread_snapshot(
        "sess_1",
        {
            "id": "thr_1",
            "status": {"type": "idle"},
            "turns": [
                {
                    "id": "turn_1",
                    "status": "completed",
                    "items": [
                        {
                            "id": "item-1",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "你是谁", "text_elements": []}],
                        },
                        {"id": "item-2", "type": "agentMessage", "text": "我是 Codex"},
                    ],
                }
            ],
        },
    )

    live_ids = {live_user.timeline_items[0]["id"], live_assistant.timeline_items[0]["id"]}
    message_items = [item for item in snapshot.timeline_items if item["type"] == "message"]
    assert not live_ids.intersection({item["id"] for item in message_items})
    assert message_items[0]["content"]["text"] == "你是谁"
    assert message_items[1]["content"]["text"] == "我是 Codex"
    assert [item["type"] for item in snapshot.timeline_items] == ["turn.start", "message", "message", "turn.end"]


def test_reducer_keeps_multiple_agent_messages_in_one_turn() -> None:
    reducer = TimelineReducer()

    snapshot = reducer.reduce_thread_snapshot(
        "sess_1",
        {
            "id": "thr_1",
            "status": {"type": "idle"},
            "turns": [
                {
                    "id": "turn_1",
                    "status": "completed",
                    "items": [
                        {"id": "item-1", "type": "userMessage", "text": "start"},
                        {"id": "item-2", "type": "agentMessage", "text": "first"},
                        {"id": "item-3", "type": "agentMessage", "text": "second"},
                    ],
                }
            ],
        },
    )

    message_items = [item for item in snapshot.timeline_items if item["type"] == "message"]
    assert [item["content"]["text"] for item in message_items] == ["start", "first", "second"]
    assert len({item["id"] for item in message_items}) == 3
    assert [item["source"].get("derivedKey") for item in message_items] == [
        "message-userMessage",
        "message-agentMessage-0",
        "message-agentMessage-1",
    ]


def test_reducer_replays_completed_turn_snapshot_without_new_completion_time() -> None:
    reducer = TimelineReducer()
    snapshot = {
        "id": "thr_1",
        "status": {"type": "idle"},
        "turns": [
            {
                "id": "turn_1",
                "status": "completed",
                "items": [{"id": "item-1", "type": "agentMessage", "text": "done"}],
            }
        ],
    }

    first = reducer.reduce_thread_snapshot("sess_1", snapshot)
    second = reducer.reduce_thread_snapshot("sess_1", snapshot)
    first_end = next(item for item in first.timeline_items if item["type"] == "turn.end")
    second_end = next(item for item in second.timeline_items if item["type"] == "turn.end")

    assert "completedAt" not in first_end
    assert "completedAt" not in second_end
    assert second_end["contentHash"] == first_end["contentHash"]
    assert second_end["revision"] == first_end["revision"]


def test_reducer_tags_user_message_with_registered_client_message_id() -> None:
    reducer = TimelineReducer()
    reducer.bind_session("sess_1", "thr_1")
    reducer.register_client_message(
        session_id="sess_1",
        thread_id="thr_1",
        turn_id="turn_1",
        client_message_id="opt_123",
        text="hello",
    )

    reduced = reducer.reduce_notification(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "item": {"id": "msg_user", "type": "userMessage", "text": "hello"},
            },
        }
    )

    assert reduced.timeline_items[0]["source"]["clientMessageId"] == "opt_123"


def test_reducer_matches_pending_client_message_after_attachment_suffix() -> None:
    reducer = TimelineReducer()
    reducer.bind_session("sess_1", "thr_1")
    reducer.register_client_message(
        session_id="sess_1",
        thread_id="thr_1",
        client_message_id="opt_file",
        text="summarize",
    )

    reduced = reducer.reduce_notification(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "item": {
                    "id": "msg_user",
                    "type": "userMessage",
                    "text": "summarize\n\n[Attached file: notes.md (text/markdown, 10 bytes) at /tmp/notes.md]",
                },
            },
        }
    )

    assert reduced.timeline_items[0]["source"]["clientMessageId"] == "opt_file"


def test_history_uses_canonical_message_keys_and_filters_bootstrap_prompt() -> None:
    reducer = TimelineReducer()

    bootstrap = "# AGENTS.md instructions for /\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS><environment_context>\n  <cwd>/</cwd>\n</environment_context>"
    reduced = reducer.reduce_history_items(
        "sess_1",
        "thr_1",
        [
            {"turnId": "turn_1", "item": {"type": "turnStart", "_derivedKey": "turn-start"}},
            {"turnId": "turn_1", "item": {"type": "userMessage", "text": bootstrap}},
            {"turnId": "turn_1", "item": {"type": "userMessage", "text": "ide是什么"}},
            {"turnId": "turn_1", "item": {"type": "agentMessage", "text": "IDE answer"}},
            {"turnId": "turn_1", "item": {"type": "turnEnd", "_derivedKey": "turn-end", "status": "completed"}},
        ],
    )

    messages = [item for item in reduced.timeline_items if item["type"] == "message"]
    assert [item["content"]["text"] for item in messages] == ["ide是什么", "IDE answer"]
    assert [item["source"].get("derivedKey") for item in messages] == [
        "message-userMessage",
        "message-agentMessage",
    ]
    turn_start = next(item for item in reduced.timeline_items if item["type"] == "turn.start")
    assert turn_start["status"] == "done"


def test_reducer_maps_codex_approval_request() -> None:
    reducer = TimelineReducer()
    reducer.bind_session("sess_1", "thr_1")

    reduced = reducer.reduce_notification(
        {
            "jsonrpc": "2.0",
            "id": 42,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "itemId": "cmd_1",
                "command": "uv run pytest -q",
                "cwd": "/repo",
            },
        }
    )

    assert reduced.session_update["status"] == "waiting_approval"
    assert reduced.timeline_items[0]["type"] == "tool"
    approval = reduced.approvals[0]
    assert approval["kind"] == "command"
    assert approval["source"]["requestId"] == 42


def test_reducer_maps_function_call_command_tool() -> None:
    reducer = TimelineReducer()
    reducer.bind_session("sess_1", "thr_1")

    started = reducer.reduce_notification(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "item": {
                    "type": "function_call",
                    "name": "exec_command",
                    "call_id": "call_1",
                    "arguments": '{"cmd":"uv run pytest -q","workdir":"/repo"}',
                },
            },
        }
    )
    completed = reducer.reduce_notification(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "item": {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "tests passed",
                },
            },
        }
    )

    assert started.timeline_items[0]["type"] == "tool"
    assert started.timeline_items[0]["content"]["kind"] == "command"
    assert started.timeline_items[0]["content"]["command"] == "uv run pytest -q"
    assert completed.timeline_items[0]["id"] == started.timeline_items[0]["id"]
    assert completed.timeline_items[0]["content"]["outputText"] == "tests passed"


def test_reducer_maps_live_command_execution_item() -> None:
    reducer = TimelineReducer()
    reducer.bind_session("sess_1", "thr_1")

    completed = reducer.reduce_notification(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "item": {
                    "id": "call_1",
                    "type": "commandExecution",
                    "command": "pwd",
                    "cwd": "/repo",
                    "aggregatedOutput": "/repo\n",
                    "exitCode": 0,
                    "durationMs": 12,
                    "processId": 123,
                    "commandActions": [{"kind": "read"}],
                    "status": "completed",
                },
            },
        }
    )

    item = completed.timeline_items[0]
    assert item["type"] == "tool"
    assert item["status"] == "done"
    assert item["content"]["kind"] == "command"
    assert item["content"]["command"] == "pwd"
    assert item["content"]["outputText"] == "/repo\n"
    assert item["content"]["exitCode"] == 0
    assert item["content"]["processId"] == 123


def test_reducer_truncates_large_tool_output_and_suppresses_unchanged_revisions() -> None:
    reducer = TimelineReducer()
    reducer.bind_session("sess_1", "thr_1")
    reducer.reduce_notification(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "item": {
                    "type": "function_call",
                    "name": "exec_command",
                    "call_id": "call_1",
                    "arguments": '{"cmd":"yes","workdir":"/repo"}',
                },
            },
        }
    )
    first = reducer.reduce_notification(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "item": {"type": "function_call_output", "call_id": "call_1", "output": "a" * 5000},
            },
        }
    ).timeline_items[0]
    second = reducer.reduce_notification(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_1",
                "item": {"type": "function_call_output", "call_id": "call_1", "output": "a" * 5000},
            },
        }
    ).timeline_items[0]

    assert len(first["content"]["outputText"]) == 4000
    assert first["content"]["outputTruncated"] is True
    assert first["content"]["outputLength"] == 5000
    assert second["revision"] == first["revision"]


def test_codex_history_reads_function_call_tools(tmp_path) -> None:
    history_dir = tmp_path / "2026" / "05" / "20"
    history_dir.mkdir(parents=True)
    history_path = history_dir / "rollout-2026-05-20T00-00-00-thr_1.jsonl"
    records = [
        {"type": "session_meta", "payload": {"id": "thr_1"}},
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn_1"}},
        {
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call_1",
                "arguments": '{"cmd":"uv run pytest -q","workdir":"/repo"}',
            },
        },
        {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "call_1", "output": "ok"}},
    ]
    history_path.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")

    history = read_tool_history("thr_1", sessions_root=tmp_path)

    assert [entry.turn_id for entry in history] == ["turn_1", "turn_1"]
    assert [entry.item["type"] for entry in history] == ["function_call", "function_call_output"]


def test_codex_history_can_read_explicit_rollout_path(tmp_path) -> None:
    other_root = tmp_path / "other"
    history_path = tmp_path / "rollout-custom.jsonl"
    records = [
        {"type": "session_meta", "payload": {"id": "different_filename"}},
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn_1"}},
        {
            "type": "response_item",
            "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "from path"}]},
        },
    ]
    history_path.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")

    history = read_timeline_history("thr_missing_in_name", rollout_path=history_path, sessions_root=other_root)

    assert [entry.item["type"] for entry in history] == ["turnStart", "userMessage"]
    assert history[1].item["content"][0]["text"] == "from path"


def test_codex_history_preserves_interleaved_message_and_tool_order(tmp_path) -> None:
    history_dir = tmp_path / "2026" / "05" / "20"
    history_dir.mkdir(parents=True)
    history_path = history_dir / "rollout-2026-05-20T00-00-00-thr_1.jsonl"
    records = [
        {"type": "session_meta", "payload": {"id": "thr_1"}},
        {"type": "event_msg", "payload": {"type": "task_started", "turn_id": "turn_1"}},
        {
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "duplicated event text should not become an item"},
        },
        {
            "type": "response_item",
            "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]},
        },
        {
            "type": "response_item",
            "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "first"}]},
        },
        {
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call_1",
                "arguments": '{"cmd":"uv run pytest -q","workdir":"/repo"}',
            },
        },
        {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "call_1", "output": "ok"}},
        {
            "type": "response_item",
            "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "second"}]},
        },
        {"type": "response_item", "payload": {"type": "reasoning", "summary": [{"text": "thinking"}]}},
        {"type": "event_msg", "payload": {"type": "task_complete", "turn_id": "turn_1"}},
    ]
    history_path.write_text("\n".join(json.dumps(record) for record in records), encoding="utf-8")

    history = read_timeline_history("thr_1", sessions_root=tmp_path)

    assert [entry.turn_id for entry in history] == ["turn_1"] * 8
    assert [entry.item["type"] for entry in history] == [
        "turnStart",
        "userMessage",
        "agentMessage",
        "function_call",
        "function_call_output",
        "agentMessage",
        "reasoning",
        "turnEnd",
    ]
    assert history[1].item["content"][0]["text"] == "hello"

    reduced = TimelineReducer().reduce_history_items(
        "sess_1",
        "thr_1",
        [{"turnId": entry.turn_id, "item": entry.item} for entry in history],
    )
    visible = [(item["type"], item.get("role"), item["content"].get("kind"), item["content"].get("text")) for item in reduced.timeline_items]
    assert visible == [
        ("turn.start", None, None, None),
        ("message", "user", None, "hello"),
        ("message", "assistant", None, "first"),
        ("tool", "tool", "command", None),
        ("tool", "tool", "command", None),
        ("message", "assistant", None, "second"),
        ("system", "system", "reasoning", None),
        ("turn.end", None, None, None),
    ]
    assert reduced.timeline_items[3]["id"] == reduced.timeline_items[4]["id"]
    assert reduced.timeline_items[4]["content"]["outputText"] == "ok"
    assert reduced.timeline_items[6]["content"]["summaries"] == [{"index": 0, "text": "thinking"}]


def test_adapter_creates_syncs_and_starts_codex_turn() -> None:
    asyncio.run(_exercise_adapter())


async def _exercise_adapter() -> None:
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def sink(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    rpc = FakeCodexRpc()
    adapter = CodexAdapter(rpc=rpc, notification_sink=sink)  # type: ignore[arg-type]

    created = await adapter.create_session({"sessionId": "sess_1", "cwd": "/repo"})
    assert created["sessionId"] == "sess_1"
    assert created["externalSessionId"] == "thr_1"

    synced = await adapter.sync_session({"sessionId": "sess_1", "externalSessionId": "thr_1"})
    methods = [notification["method"] for notification in synced["backendNotifications"]]
    assert methods == ["session.updated", "timeline.sync"]
    assert len(synced["backendNotifications"][1]["params"]["items"]) == 4

    turn = await adapter.start_turn({"sessionId": "sess_1", "content": "continue"})
    assert turn["turnId"] == "turn_2"
    assert [request[0] for request in rpc.requests].count("thread/resume") == 0
    assert rpc.requests[-1][0] == "turn/start"
    assert rpc.requests[-1][1]["threadId"] == "thr_1"

    await adapter.handle_notification(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_2",
                "item": {"id": "msg_1", "type": "agentMessage", "text": "done", "status": "completed"},
            },
        }
    )
    assert notifications[-1][0] == "timeline.itemUpsert"
    assert notifications[-1][1]["item"]["content"]["text"] == "done"

    await adapter.resolve_approval({"requestId": 42, "status": "approved"})
    assert rpc.responses[-1] == (42, {"decision": "accept"})


def test_adapter_maps_thread_start_sandbox_policy_to_mode() -> None:
    async def exercise() -> None:
        rpc = FakeCodexRpc()
        adapter = CodexAdapter(rpc=rpc)  # type: ignore[arg-type]

        await adapter.create_session(
            {
                "sessionId": "sess_1",
                "cwd": "/repo",
                "sandbox": {
                    "type": "workspaceWrite",
                    "writableRoots": ["/repo"],
                    "networkAccess": False,
                },
            }
        )

        method, params = rpc.requests[-1]
        assert method == "thread/start"
        assert params is not None
        assert params["sandbox"] == "workspace-write"

    asyncio.run(exercise())


def test_adapter_creates_stable_session_id_for_new_thread() -> None:
    async def exercise() -> None:
        rpc = FakeCodexRpc()
        adapter = CodexAdapter(rpc=rpc)  # type: ignore[arg-type]
        created = await adapter.create_session({"connectorId": "conn_1", "cwd": "/repo"})
        session_id = stable_session_id("conn_1", "thr_1")
        assert created["sessionId"] == session_id
        assert created["backendNotifications"][0]["params"]["sessionId"] == session_id

    asyncio.run(exercise())


def test_adapter_sync_uses_thread_read_snapshot_only() -> None:
    asyncio.run(_exercise_thread_read_only_sync())


def test_adapter_sync_preserves_requested_thread_id_when_snapshot_omits_id() -> None:
    async def exercise() -> None:
        class MissingSnapshotIdRpc(FakeCodexRpc):
            async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
                result = await super().request(method, params)
                if method == "thread/read":
                    thread = result["thread"]
                    thread.pop("id", None)
                return result

        rpc = MissingSnapshotIdRpc()
        adapter = CodexAdapter(rpc=rpc)  # type: ignore[arg-type]

        synced = await adapter.sync_session({"sessionId": "sess_1", "externalSessionId": "thr_1"})
        session_update = synced["backendNotifications"][0]["params"]
        timeline_items = synced["backendNotifications"][1]["params"]["items"]

        assert session_update["externalSessionId"] == "thr_1"
        assert adapter.reducer is not None
        assert adapter.reducer.thread_for_session("sess_1") == "thr_1"
        assert all(item["source"]["sessionId"] == "thr_1" for item in timeline_items)

    asyncio.run(exercise())


def test_adapter_sync_prefers_requested_thread_id_when_snapshot_id_drifts() -> None:
    async def exercise() -> None:
        class DriftSnapshotIdRpc(FakeCodexRpc):
            async def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
                result = await super().request(method, params)
                if method == "thread/read":
                    result["thread"]["id"] = "thr_fork_child"
                return result

        rpc = DriftSnapshotIdRpc()
        adapter = CodexAdapter(rpc=rpc)  # type: ignore[arg-type]

        synced = await adapter.sync_session({"sessionId": "sess_parent", "externalSessionId": "thr_parent"})
        session_update = synced["backendNotifications"][0]["params"]
        timeline_items = synced["backendNotifications"][1]["params"]["items"]

        assert session_update["externalSessionId"] == "thr_parent"
        assert adapter.reducer is not None
        assert adapter.reducer.thread_for_session("sess_parent") == "thr_parent"
        assert adapter.reducer.session_for_thread("thr_fork_child") is None
        assert all(item["source"]["sessionId"] == "thr_parent" for item in timeline_items)

    asyncio.run(exercise())


def test_adapter_interrupt_thread_not_found_is_soft_result() -> None:
    async def exercise() -> None:
        rpc = InterruptThreadNotFoundRpc()
        adapter = CodexAdapter(rpc=rpc)  # type: ignore[arg-type]

        result = await adapter.interrupt_turn(
            {
                "sessionId": "sess_1",
                "externalSessionId": "thr_missing",
                "turnId": "turn_missing",
            }
        )

        assert result == {"interrupted": False, "reason": "thread_not_found"}

    asyncio.run(exercise())


async def _exercise_thread_read_only_sync() -> None:
    rpc = FakeCodexRpc()
    adapter = CodexAdapter(rpc=rpc)  # type: ignore[arg-type]

    synced = await adapter.sync_session({"sessionId": "sess_1", "externalSessionId": "thr_1"})
    items = synced["backendNotifications"][1]["params"]["items"]
    messages = [item for item in items if item["type"] == "message"]
    command_items = [item for item in items if item["type"] == "tool" and item["content"].get("kind") == "command"]

    assert [item["content"]["text"] for item in messages] == ["hello", "hi"]
    assert command_items == []


def test_adapter_discovers_existing_codex_threads() -> None:
    asyncio.run(_exercise_existing_thread_sync())


def test_adapter_uses_persisted_sync_marker_after_restart(tmp_path) -> None:
    asyncio.run(_exercise_persisted_existing_thread_sync(tmp_path))


def test_adapter_uses_separate_scan_and_changed_thread_timeouts(monkeypatch) -> None:
    asyncio.run(_exercise_existing_thread_sync_timeouts(monkeypatch))


async def _exercise_existing_thread_sync() -> None:
    rpc = FakeCodexRpc()
    adapter = CodexAdapter(rpc=rpc)  # type: ignore[arg-type]

    sent_notifications: list[list[dict[str, Any]]] = []

    async def sink(notifications: list[dict[str, Any]]) -> None:
        sent_notifications.append(notifications)

    result = await adapter.sync_existing_sessions("conn_1")
    session_id = stable_session_id("conn_1", "thr_existing")

    assert result["threads"] == ["thr_existing"]
    assert [notification["method"] for notification in result["backendNotifications"]] == [
        "session.updated",
        "timeline.sync",
    ]
    assert result["backendNotifications"][0]["params"]["sessionId"] == session_id
    assert result["backendNotifications"][0]["params"]["externalSessionId"] == "thr_existing"
    assert result["backendNotifications"][0]["params"]["lastActivityAt"] == "2026-05-20T15:35:18Z"
    assert ("thread/list", {"limit": 100, "sortKey": "updated_at"}) in rpc.requests
    assert ("thread/resume", {"threadId": "thr_existing"}) in rpc.requests
    assert ("thread/read", {"threadId": "thr_existing", "includeTurns": True}) in rpc.requests

    streamed = await adapter.sync_existing_sessions("conn_1", notification_sink=sink)
    assert streamed["threads"] == []
    assert streamed["skippedThreads"] == ["thr_existing"]
    assert streamed["backendNotifications"] == []
    assert sent_notifications == []
    assert rpc.requests.count(("thread/read", {"threadId": "thr_existing", "includeTurns": True})) == 1

    forced = await adapter.sync_existing_sessions("conn_1", force=True, notification_sink=sink)
    assert forced["threads"] == ["thr_existing"]
    assert forced["skippedThreads"] == []
    assert [notification["method"] for notification in sent_notifications[0]] == ["session.updated", "timeline.sync"]


async def _exercise_persisted_existing_thread_sync(tmp_path) -> None:
    store = SqliteSyncStateStore(tmp_path / "connector-state.sqlite3")
    first_rpc = FakeCodexRpc()
    first_adapter = CodexAdapter(rpc=first_rpc, sync_state_store=store)  # type: ignore[arg-type]

    first = await first_adapter.sync_existing_sessions("conn_1")
    assert first["threads"] == ["thr_existing"]
    assert ("thread/read", {"threadId": "thr_existing", "includeTurns": True}) in first_rpc.requests

    second_rpc = FakeCodexRpc()
    second_adapter = CodexAdapter(rpc=second_rpc, sync_state_store=store)  # type: ignore[arg-type]

    second = await second_adapter.sync_existing_sessions("conn_1")
    assert second["threads"] == []
    assert second["skippedThreads"] == ["thr_existing"]
    assert ("thread/read", {"threadId": "thr_existing", "includeTurns": True}) not in second_rpc.requests


async def _exercise_existing_thread_sync_timeouts(monkeypatch) -> None:
    rpc = FakeCodexRpc()
    adapter = CodexAdapter(rpc=rpc)  # type: ignore[arg-type]
    timeouts: list[float | None] = []
    real_wait_for = asyncio.wait_for

    async def recording_wait_for(awaitable, *, timeout=None):
        timeouts.append(timeout)
        return await real_wait_for(awaitable, timeout=timeout)

    monkeypatch.setattr(asyncio, "wait_for", recording_wait_for)

    result = await adapter.sync_existing_sessions("conn_1")

    assert result["threads"] == ["thr_existing"]
    assert timeouts[:2] == [
        EXISTING_SYNC_SCAN_TIMEOUT_SECONDS,
        EXISTING_SYNC_CHANGED_THREAD_TIMEOUT_SECONDS,
    ]


def test_adapter_pushes_thread_read_snapshot_after_turn_completion() -> None:
    asyncio.run(_exercise_delayed_thread_read_sync())


async def _exercise_delayed_thread_read_sync() -> None:
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def sink(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    rpc = FakeCodexRpc()
    adapter = CodexAdapter(rpc=rpc, notification_sink=sink)  # type: ignore[arg-type]
    await adapter.start()
    adapter.reducer.bind_session("sess_1", "thr_1")

    await adapter.handle_notification(
        {
            "method": "turn/completed",
            "params": {"threadId": "thr_1", "turnId": "turn_1", "turn": {"status": "completed"}},
        }
    )
    await asyncio.sleep(0.6)

    sync_batches = [params for method, params in notifications if method == "timeline.sync"]
    assert sync_batches
    assert any(item["type"] == "message" and item["content"]["text"] == "hi" for item in sync_batches[-1]["items"])
    assert ("thread/read", {"threadId": "thr_1", "includeTurns": True}) in rpc.requests


def test_adapter_registers_client_message_id_after_turn_start() -> None:
    asyncio.run(_exercise_adapter_registers_client_message_id())


async def _exercise_adapter_registers_client_message_id() -> None:
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def sink(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    rpc = FakeCodexRpc()
    adapter = CodexAdapter(rpc=rpc, notification_sink=sink)  # type: ignore[arg-type]
    adapter.reducer.bind_session("sess_1", "thr_1")

    await adapter.start_turn(
        {
            "sessionId": "sess_1",
            "externalSessionId": "thr_1",
            "content": "hello",
            "clientMessageId": "opt_hello",
        }
    )
    await adapter.handle_notification(
        {
            "method": "item/completed",
            "params": {
                "threadId": "thr_1",
                "turnId": "turn_2",
                "item": {"id": "msg_user", "type": "userMessage", "text": "hello"},
            },
        }
    )

    user_items = [
        params["item"]
        for method, params in notifications
        if method == "timeline.itemUpsert"
        and params["item"]["type"] == "message"
        and params["item"].get("role") == "user"
    ]
    assert user_items[-1]["source"]["clientMessageId"] == "opt_hello"
