from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeAttachmentContent,
    RuntimeConfig,
    RuntimeHostClient,
    RuntimeStatus,
    RuntimeTimelineItem,
)
from connector.runtimes.claude.domain.session import stable_session_id
from connector.runtimes.claude.runtime import ClaudeRuntime


def test_claude_runtime_lifecycle_and_config() -> None:
    asyncio.run(_test_claude_runtime_lifecycle_and_config())


async def _test_claude_runtime_lifecycle_and_config() -> None:
    runtime = _runtime()

    assert runtime.identity.runtime == "claude"
    assert runtime.identity.display_name == "Claude"
    assert await runtime.get_config() == _config()

    await runtime.start()
    await runtime.stop()


def test_claude_runtime_reports_initial_runtime_capabilities() -> None:
    asyncio.run(_test_claude_runtime_reports_initial_runtime_capabilities())


async def _test_claude_runtime_reports_initial_runtime_capabilities() -> None:
    runtime = _runtime()

    capability_set = await runtime.get_runtime_capabilities()
    capabilities = {
        capability.capability_id: capability
        for capability in capability_set.capabilities
    }

    assert capability_set.runtime == "claude"
    assert capability_set.connector_id == "conn_test"
    assert capabilities["session.send_message"].supported is True
    assert capabilities["session.send_message"].available is True
    assert capabilities["catalog.model"].supported is True
    assert capabilities["catalog.model"].available is True
    assert capabilities["catalog.effort"].supported is True
    assert capabilities["catalog.effort"].available is True
    assert capabilities["session.interrupt"].supported is True
    assert capabilities["session.interrupt"].available is True
    assert capabilities["session.interaction.approval"].supported is True
    assert capabilities["session.interaction.approval"].available is True
    assert capabilities["catalog.permission"].supported is True
    assert capabilities["catalog.permission"].available is True
    assert capabilities["runtime.attachment"].supported is True
    assert capabilities["runtime.attachment"].available is True


def test_claude_runtime_empty_reads_are_stable() -> None:
    asyncio.run(_test_claude_runtime_empty_reads_are_stable())


async def _test_claude_runtime_empty_reads_are_stable() -> None:
    runtime = _runtime()

    assert await runtime.list_sessions() == ()
    empty_snapshot = await runtime.get_session_snapshot("missing")
    assert empty_snapshot.runtime == "claude"
    assert empty_snapshot.items == ()
    catalog = await runtime.list_model_catalog(query="sonnet")
    assert [model.id for model in catalog.models] == ["claude-sonnet-4-5"]
    assert catalog.models[0].selection_id is None
    assert [item.id for item in catalog.models[0].reasoning_items] == [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]
    assert [item.id for item in (await runtime.list_permission_catalog()).permissions] == [
        "default",
        "acceptEdits",
        "plan",
        "auto",
        "dontAsk",
        "bypassPermissions",
    ]


def test_claude_runtime_starts_turn_and_projects_timeline() -> None:
    asyncio.run(_test_claude_runtime_starts_turn_and_projects_timeline())


async def _test_claude_runtime_starts_turn_and_projects_timeline() -> None:
    host = _RecordingHost()
    client = _FakeClaudeClient(
        messages=[
            SimpleNamespace(
                type="assistant",
                uuid="assistant_1",
                session_id="claude_session_1",
                message={
                    "role": "assistant",
                    "content": [{"type": "text", "text": "do"}],
                },
            ),
            SimpleNamespace(
                type="assistant",
                uuid="assistant_1",
                session_id="claude_session_1",
                message={
                    "role": "assistant",
                    "content": [{"type": "text", "text": "done"}],
                },
            ),
            SimpleNamespace(
                type="result",
                session_id="claude_session_1",
                is_error=False,
            ),
        ]
    )
    runtime = _runtime(host=host, client=client)

    result = await runtime.start_turn(
        "sess_1",
        "claude_session_0",
        "hello",
        client_message_id="client_msg_1",
    )
    task = runtime._sessions["sess_1"].active_task

    assert result.ok is True
    assert result.result["turnId"].startswith("turn_claude_")
    assert result.result["externalSessionId"] == "claude_session_0"
    assert task is not None

    await task

    assert client.connected is True
    assert client.disconnected is True
    assert client.queries == ["hello"]
    assert client.options.kwargs["resume"] == "claude_session_0"
    assert runtime._sessions["sess_1"].external_session_id == "claude_session_1"
    assert [update["status"] for update in host.session_state_updates] == [
        "waiting",
        "running",
        "idle",
    ]
    assert [item.role for item in host.timeline_item_upserts] == [
        "user",
        "assistant",
        "assistant",
    ]
    user_item, first_assistant_item, assistant_item = host.timeline_item_upserts
    assert user_item.content["text"] == "hello"
    assert user_item.source["clientMessageId"] == "client_msg_1"
    assert first_assistant_item.id == assistant_item.id
    assert assistant_item.content["text"] == "done"
    assert assistant_item.source["sessionId"] == "claude_session_1"
    assert assistant_item.source["itemId"] == "assistant_1"


def test_claude_runtime_create_and_start_publishes_session_meta() -> None:
    asyncio.run(_test_claude_runtime_create_and_start_publishes_session_meta())


async def _test_claude_runtime_create_and_start_publishes_session_meta() -> None:
    host = _RecordingHost()
    client = _FakeClaudeClient(
        messages=[SimpleNamespace(type="result", session_id="claude_session_2")]
    )
    runtime = _runtime(host=host, client=client)

    result = await runtime.create_and_start_session(
        "sess_new",
        "start",
        title="New session",
        cwd="/repo",
    )
    task = runtime._sessions["sess_new"].active_task

    assert result.ok is True
    assert result.result["sessionId"] == "sess_new"
    assert host.session_meta_upserts[0]["title"] == "New session"
    assert host.session_meta_upserts[0]["cwd"] == "/repo"
    assert task is not None

    await task

    assert client.options.kwargs["cwd"] == "/repo"
    assert runtime._sessions["sess_new"].external_session_id == "claude_session_2"


def test_claude_runtime_lists_sessions_and_returns_local_snapshot() -> None:
    asyncio.run(_test_claude_runtime_lists_sessions_and_returns_local_snapshot())


async def _test_claude_runtime_lists_sessions_and_returns_local_snapshot() -> None:
    host = _RecordingHost()
    client = _FakeClaudeClient(
        messages=[
            SimpleNamespace(
                type="assistant",
                uuid="assistant_snapshot",
                session_id="claude_snapshot",
                message={
                    "role": "assistant",
                    "content": [{"type": "text", "text": "snapshot done"}],
                },
            ),
            SimpleNamespace(type="result", session_id="claude_snapshot"),
        ]
    )
    runtime = _runtime(host=host, client=client)

    result = await runtime.create_and_start_session(
        "sess_snapshot",
        "snapshot please",
        title="Snapshot session",
        cwd="/repo",
    )
    task = runtime._sessions["sess_snapshot"].active_task

    assert result.ok is True
    assert task is not None

    await task

    sessions = await runtime.list_sessions()
    assert len(sessions) == 1
    session = sessions[0]
    assert session.session_id == "sess_snapshot"
    assert session.external_session_id == "claude_snapshot"
    assert session.title == "Snapshot session"
    assert session.cwd == "/repo"
    assert session.metadata["sync"]["requires_timeline_sync"] is True

    snapshot = await runtime.get_session_snapshot("sess_snapshot", "claude_snapshot")

    assert snapshot.external_session_id == "claude_snapshot"
    assert [item.role for item in snapshot.items] == ["user", "assistant"]
    assert snapshot.items[0].content["text"] == "snapshot please"
    assert snapshot.items[1].content["text"] == "snapshot done"
    assert host.session_meta_upserts[-1]["external_session_id"] == "claude_snapshot"

    sessions_after_snapshot = await runtime.list_sessions()
    assert (
        sessions_after_snapshot[0].metadata["sync"]["requires_timeline_sync"] is False
    )


def test_claude_runtime_lists_sessions_from_sdk_history() -> None:
    asyncio.run(_test_claude_runtime_lists_sessions_from_sdk_history())


async def _test_claude_runtime_lists_sessions_from_sdk_history() -> None:
    host = _RecordingHost()
    sdk = _HistorySdk(
        sessions=[
            SimpleNamespace(
                session_id="claude_history_1",
                summary="History session",
                custom_title=None,
                first_prompt="first prompt",
                cwd="/repo",
                last_modified=1_789_000_000_000,
                file_size=123,
                created_at=1_788_000_000_000,
                git_branch="benson-workspace",
            )
        ]
    )
    runtime = _runtime(host=host, sdk=sdk)

    sessions = await runtime.list_sessions(limit=10)

    assert len(sessions) == 1
    session = sessions[0]
    assert session.session_id == stable_session_id("conn_test", "claude_history_1")
    assert session.external_session_id == "claude_history_1"
    assert session.title == "History session"
    assert session.cwd == "/repo"
    assert session.ordering_time == "2026-09-10T00:26:40Z"
    assert session.metadata["source"] == "claude.session/list"
    assert session.metadata["sync"]["changed"] is True
    assert session.metadata["sync"]["requires_timeline_sync"] is True
    assert host.sync_states["claude/session-sync/claude_history_1"]["session_id"] == (
        stable_session_id("conn_test", "claude_history_1")
    )
    assert sdk.list_calls == [{"limit": 10, "offset": 0}]


def test_claude_runtime_session_sync_marker_skips_unchanged_history() -> None:
    asyncio.run(_test_claude_runtime_session_sync_marker_skips_unchanged_history())


async def _test_claude_runtime_session_sync_marker_skips_unchanged_history() -> None:
    host = _RecordingHost()
    sdk = _HistorySdk(
        sessions=[
            SimpleNamespace(
                session_id="claude_history_unchanged",
                summary="History",
                last_modified=1_789_000_000_000,
                file_size=123,
            )
        ]
    )
    runtime = _runtime(host=host, sdk=sdk)

    first = await runtime.list_sessions(limit=10)
    second = await runtime.list_sessions(limit=10)
    forced = await runtime.list_sessions(limit=10, force=True)

    assert first[0].metadata["sync"]["changed"] is True
    assert second[0].metadata["sync"]["changed"] is False
    assert second[0].metadata["sync"]["requires_timeline_sync"] is False
    assert forced[0].metadata["sync"]["changed"] is True
    assert forced[0].metadata["sync"]["requires_timeline_sync"] is True


def test_claude_runtime_projects_sdk_history_snapshot() -> None:
    asyncio.run(_test_claude_runtime_projects_sdk_history_snapshot())


async def _test_claude_runtime_projects_sdk_history_snapshot() -> None:
    sdk = _HistorySdk(
        infos={
            "claude_history_snapshot": SimpleNamespace(
                session_id="claude_history_snapshot",
                summary="Snapshot",
                cwd="/repo",
                last_modified=1_789_000_000_000,
                file_size=234,
            )
        },
        messages={
            "claude_history_snapshot": [
                SimpleNamespace(
                    type="user",
                    uuid="user_1",
                    session_id="claude_history_snapshot",
                    message={"role": "user", "content": "hello"},
                ),
                SimpleNamespace(
                    type="assistant",
                    uuid="assistant_1",
                    session_id="claude_history_snapshot",
                    message={
                        "role": "assistant",
                        "content": [{"type": "text", "text": "hi"}],
                    },
                ),
                SimpleNamespace(
                    type="assistant",
                    uuid="assistant_tool",
                    session_id="claude_history_snapshot",
                    message={
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "tool_1",
                                "name": "Bash",
                                "input": {"command": "pwd"},
                            }
                        ],
                    },
                ),
                SimpleNamespace(
                    type="user",
                    uuid="tool_result_1",
                    session_id="claude_history_snapshot",
                    message={
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": "tool_1",
                                "content": "/repo",
                            }
                        ],
                    },
                ),
            ]
        },
    )
    runtime = _runtime(sdk=sdk)
    session_id = stable_session_id("conn_test", "claude_history_snapshot")

    snapshot = await runtime.get_session_snapshot(
        session_id,
        "claude_history_snapshot",
    )

    assert snapshot.runtime == "claude"
    assert snapshot.external_session_id == "claude_history_snapshot"
    assert snapshot.metadata["source"] == "claude.session.history"
    assert [item.type for item in snapshot.items] == [
        "message",
        "message",
        "tool",
        "tool",
    ]
    assert [item.role for item in snapshot.items[:2]] == ["user", "assistant"]
    assert snapshot.items[0].content["text"] == "hello"
    assert snapshot.items[1].content["text"] == "hi"
    assert snapshot.items[2].content["kind"] == "command"
    assert snapshot.items[2].content["command"] == "pwd"
    assert snapshot.items[3].status == "done"
    assert snapshot.items[3].content["output"] == "/repo"


def test_claude_runtime_session_state_defaults_to_idle_for_known_history() -> None:
    asyncio.run(_test_claude_runtime_session_state_defaults_to_idle_for_known_history())


async def _test_claude_runtime_session_state_defaults_to_idle_for_known_history() -> None:
    sdk = _HistorySdk(
        infos={
            "claude_history_state": SimpleNamespace(
                session_id="claude_history_state",
                summary="State",
            )
        }
    )
    runtime = _runtime(sdk=sdk)

    state = await runtime.get_session_state(
        "sess_history_state",
        "claude_history_state",
    )

    assert state is not None
    assert state.status == "idle"
    assert state.runtime == "claude"
    assert state.metadata["source"] == "claude.session.history.state"


def test_claude_runtime_applies_permission_selection_to_sdk_options() -> None:
    asyncio.run(_test_claude_runtime_applies_permission_selection_to_sdk_options())


async def _test_claude_runtime_applies_permission_selection_to_sdk_options() -> None:
    host = _RecordingHost()
    client = _FakeClaudeClient(
        messages=[SimpleNamespace(type="result", session_id="claude_permission")]
    )
    runtime = _runtime(host=host, client=client)
    permission = (await runtime.list_permission_catalog(query="plan")).permissions[0]

    update = await runtime.update_session_selections(
        "sess_permission",
        "claude_permission",
        {"permission": permission.selection_id},
    )
    result = await runtime.start_turn(
        "sess_permission",
        "claude_permission",
        "plan",
    )
    task = runtime._sessions["sess_permission"].active_task

    assert update.ok is True
    assert result.ok is True
    assert task is not None

    await task

    assert client.options.kwargs["permission_mode"] == "plan"
    assert host.session_state_updates[0]["selections"] == {
        "permission": permission.selection_id
    }
    assert host.session_state_updates[1]["selections"] == {
        "permission": permission.selection_id
    }


def test_claude_runtime_applies_model_selection_to_sdk_options() -> None:
    asyncio.run(_test_claude_runtime_applies_model_selection_to_sdk_options())


async def _test_claude_runtime_applies_model_selection_to_sdk_options() -> None:
    host = _RecordingHost()
    client = _FakeClaudeClient(
        messages=[SimpleNamespace(type="result", session_id="claude_model")]
    )
    runtime = _runtime(host=host, client=client)
    model = (await runtime.list_model_catalog(query="sonnet")).models[0]
    effort = next(
        item for item in model.reasoning_items if item.id == "high"
    )

    result = await runtime.start_turn(
        "sess_model",
        "claude_model",
        "use model",
        selections={"model": effort.selection_id},
    )
    task = runtime._sessions["sess_model"].active_task

    assert result.ok is True
    assert task is not None

    await task

    assert client.options.kwargs["model"] == "claude-sonnet-4-5"
    assert client.options.kwargs["effort"] == "high"
    assert host.session_state_updates[0]["selections"] == {
        "model": effort.selection_id
    }


def test_claude_runtime_rejects_unknown_model_selection() -> None:
    asyncio.run(_test_claude_runtime_rejects_unknown_model_selection())


async def _test_claude_runtime_rejects_unknown_model_selection() -> None:
    runtime = _runtime()

    result = await runtime.start_turn(
        "sess_bad_model",
        None,
        "hello",
        selections={"model": "sel_model_missing"},
    )

    assert result.ok is False
    assert result.code == "claude_invalid_selection"


def test_claude_runtime_rejects_unknown_permission_selection() -> None:
    asyncio.run(_test_claude_runtime_rejects_unknown_permission_selection())


async def _test_claude_runtime_rejects_unknown_permission_selection() -> None:
    runtime = _runtime()

    result = await runtime.start_turn(
        "sess_bad_permission",
        None,
        "hello",
        selections={"permission": "sel_permission_missing"},
    )

    assert result.ok is False
    assert result.code == "claude_invalid_selection"


def test_claude_runtime_projects_tool_blocks_to_timeline() -> None:
    asyncio.run(_test_claude_runtime_projects_tool_blocks_to_timeline())


async def _test_claude_runtime_projects_tool_blocks_to_timeline() -> None:
    host = _RecordingHost()
    client = _FakeClaudeClient(
        messages=[
            SimpleNamespace(
                type="assistant",
                session_id="claude_tool_session",
                message={
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "id": "tool_1",
                            "name": "Bash",
                            "input": {"command": "pytest"},
                        }
                    ],
                },
            ),
            SimpleNamespace(
                type="user",
                session_id="claude_tool_session",
                message={
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "tool_1",
                            "content": "ok",
                        }
                    ],
                },
            ),
            SimpleNamespace(type="result", session_id="claude_tool_session"),
        ]
    )
    runtime = _runtime(host=host, client=client)

    result = await runtime.start_turn("sess_tools", "claude_tool_session", "run tests")
    task = runtime._sessions["sess_tools"].active_task

    assert result.ok is True
    assert task is not None

    await task

    tool_call, tool_result = [
        item for item in host.timeline_item_upserts if item.type == "tool"
    ]
    assert tool_call.id == tool_result.id
    assert tool_call.status == "running"
    assert tool_call.content["kind"] == "command"
    assert tool_call.content["command"] == "pytest"
    assert tool_call.source["itemType"] == "tool_use"
    assert tool_result.status == "done"
    assert tool_result.content["kind"] == "tool_result"
    assert tool_result.content["output"] == "ok"
    assert tool_result.content["toolName"] == "Bash"
    assert tool_result.source["itemType"] == "tool_result"


def test_claude_runtime_interrupts_active_turn() -> None:
    asyncio.run(_test_claude_runtime_interrupts_active_turn())


async def _test_claude_runtime_interrupts_active_turn() -> None:
    host = _RecordingHost()
    release = asyncio.Event()
    client = _BlockingClaudeClient(release)
    runtime = _runtime(host=host, client=client)

    result = await runtime.start_turn("sess_interrupt", None, "wait")
    assert result.ok is True
    await _wait_until(lambda: bool(client.queries))

    active_capabilities = {
        capability.capability_id: capability
        for capability in (
            await runtime.get_session_capabilities("sess_interrupt")
        ).capabilities
    }
    assert active_capabilities["session.send_message"].available is False
    assert active_capabilities["session.interrupt"].available is True

    task = runtime._sessions["sess_interrupt"].active_task
    interrupt_result = await runtime.interrupt_turn("sess_interrupt", reason="user")

    assert interrupt_result.ok is True
    assert interrupt_result.result["interrupted"] is True
    assert client.interrupted is True
    assert task is not None

    await asyncio.gather(task, return_exceptions=True)
    release.set()

    assert client.disconnected is True
    assert runtime._sessions["sess_interrupt"].active_turn_id is None
    assert host.session_state_updates[-1]["status"] == "idle"


def test_claude_runtime_materializes_attachments_for_turn_start(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    monkeypatch.setenv("AGENT_CONNECTOR_ATTACHMENTS_ROOT", str(tmp_path))
    asyncio.run(_test_claude_runtime_materializes_attachments_for_turn_start())


async def _test_claude_runtime_materializes_attachments_for_turn_start() -> None:
    host = _RecordingHost()
    host.attachments["file_1"] = RuntimeAttachmentContent(
        file_id="file_1",
        name="note.txt",
        media_type="text/plain",
        content=b"hello attachment",
    )
    client = _FakeClaudeClient(
        messages=[SimpleNamespace(type="result", session_id="claude_attachments")]
    )
    runtime = _runtime(host=host, client=client)

    result = await runtime.start_turn(
        "sess_attachments",
        "claude_attachments",
        "read this",
        attachments=(RuntimeAttachment(file_id="file_1", name="note.txt"),),
    )
    task = runtime._sessions["sess_attachments"].active_task

    assert result.ok is True
    assert task is not None

    await task

    attachment = host.timeline_item_upserts[0].content["attachments"][0]
    assert attachment["name"] == "note.txt"
    assert attachment["mediaType"] == "text/plain"
    assert attachment["byteSize"] == 16
    assert Path(str(attachment["path"])).read_bytes() == b"hello attachment"
    assert client.queries[0].startswith("read this\n\nAttached files:")
    assert str(attachment["path"]) in client.queries[0]


def test_claude_runtime_tool_approval_round_trips_to_sdk() -> None:
    asyncio.run(_test_claude_runtime_tool_approval_round_trips_to_sdk())


async def _test_claude_runtime_tool_approval_round_trips_to_sdk() -> None:
    host = _RecordingHost()
    client = _ApprovalClaudeClient()
    runtime = _runtime(host=host, client=client)

    result = await runtime.start_turn(
        "sess_approval",
        "claude_session_approval",
        "run ls",
    )
    task = runtime._sessions["sess_approval"].active_task

    assert result.ok is True
    assert task is not None
    await _wait_until(lambda: bool(host.notice_upserts))

    notice = host.notice_upserts[0]
    assert notice.status == "open"
    assert notice.interaction_type == "approval"
    assert notice.message == "ls"
    assert notice.context["toolName"] == "Bash"
    assert notice.context["toolInput"] == {"command": "ls"}
    assert await runtime.get_session_notices("sess_approval") == (notice,)
    assert [update["status"] for update in host.session_state_updates][-3:] == [
        "waiting",
        "running",
        "blocked",
    ]
    assert client.options.kwargs["permission_prompt_tool_name"] == "stdio"

    response = await runtime.respond_interaction(
        "sess_approval",
        notice.notice_id,
        "approve",
    )

    assert response.ok is True

    await task

    assert [notice.status for notice in host.notice_upserts] == [
        "open",
        "responding",
        "resolved",
    ]
    assert isinstance(client.permission_results[0], _PermissionResultAllow)
    assert client.permission_results[0].behavior == "allow"
    assert await runtime.get_session_notices("sess_approval") == ()
    assert host.session_state_updates[-1]["status"] == "idle"


def _runtime(
    host: _RecordingHost | None = None,
    client: "_FakeClaudeClient | None" = None,
    sdk: Any | None = None,
) -> ClaudeRuntime:
    active_host = host or _RecordingHost()
    active_client = client or _FakeClaudeClient()
    active_sdk = sdk or _default_sdk()

    def client_factory(sdk: Any, options: Any) -> _FakeClaudeClient:
        _ = sdk
        active_client.options = options
        return active_client

    return ClaudeRuntime(
        config=_config(),
        host=active_host,
        sdk_loader=lambda: active_sdk,
        client_factory=client_factory,
    )


def _default_sdk() -> Any:
    return SimpleNamespace(
        __version__="1.0",
        ClaudeAgentOptions=_FakeOptions,
        PermissionResultAllow=_PermissionResultAllow,
        PermissionResultDeny=_PermissionResultDeny,
        list_sessions=lambda **_: [],
        get_session_info=lambda **_: None,
        get_session_messages=lambda **_: [],
    )


def _config() -> RuntimeConfig:
    return RuntimeConfig(
        runtime="claude",
        revision=1,
        values={"environment": {}},
    )


class _FakeOptions:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


class _FakeClaudeClient:
    def __init__(self, messages: list[Any] | None = None) -> None:
        self.messages = list(messages or [])
        self.options: Any = None
        self.connected = False
        self.disconnected = False
        self.interrupted = False
        self.queries: list[str] = []

    async def connect(self) -> None:
        self.connected = True

    async def disconnect(self) -> None:
        self.disconnected = True

    async def query(self, prompt: str) -> None:
        self.queries.append(prompt)

    async def receive_response(self) -> list[Any]:
        return self.messages

    async def interrupt(self) -> None:
        self.interrupted = True


class _ApprovalClaudeClient(_FakeClaudeClient):
    def __init__(self) -> None:
        super().__init__()
        self.permission_results: list[Any] = []

    async def receive_response(self) -> list[Any]:
        can_use_tool = self.options.kwargs["can_use_tool"]
        result = await can_use_tool(
            "Bash",
            {"command": "ls"},
            SimpleNamespace(session_id="claude_session_approval"),
        )
        self.permission_results.append(result)
        return [SimpleNamespace(type="result", session_id="claude_session_approval")]


class _BlockingClaudeClient(_FakeClaudeClient):
    def __init__(self, release: asyncio.Event) -> None:
        super().__init__()
        self._release = release

    async def receive_response(self) -> list[Any]:
        await self._release.wait()
        return []


class _HistorySdk:
    def __init__(
        self,
        sessions: list[Any] | None = None,
        infos: dict[str, Any] | None = None,
        messages: dict[str, list[Any]] | None = None,
    ) -> None:
        self.__version__ = "1.0"
        self.ClaudeAgentOptions = _FakeOptions
        self.PermissionResultAllow = _PermissionResultAllow
        self.PermissionResultDeny = _PermissionResultDeny
        self.sessions = list(sessions or [])
        self.infos = dict(infos or {})
        self.messages = dict(messages or {})
        self.list_calls: list[dict[str, Any]] = []

    def list_sessions(
        self,
        limit: int | None = None,
        offset: int = 0,
    ) -> list[Any]:
        self.list_calls.append({"limit": limit, "offset": offset})
        sessions = self.sessions[offset:]
        return sessions[:limit] if limit is not None else sessions

    def get_session_info(self, session_id: str) -> Any | None:
        return self.infos.get(session_id)

    def get_session_messages(self, session_id: str) -> list[Any]:
        return list(self.messages.get(session_id, []))


class _RecordingHost(RuntimeHostClient):
    def __init__(self) -> None:
        self.session_meta_upserts: list[dict[str, Any]] = []
        self.session_state_updates: list[dict[str, Any]] = []
        self.timeline_item_upserts: list[RuntimeTimelineItem] = []
        self.notice_upserts: list[Any] = []
        self.attachments: dict[str, RuntimeAttachmentContent] = {}
        self.sync_states: dict[str, dict[str, Any]] = {}

    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def session_meta_upsert(
        self,
        session_id: str,
        runtime: str,
        external_session_id: str | None = None,
        title: str | None = None,
        cwd: str | None = None,
        ordering_time: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.session_meta_upserts.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "external_session_id": external_session_id,
                "title": title,
                "cwd": cwd,
                "ordering_time": ordering_time,
                "metadata": metadata,
            }
        )

    async def session_state_update(
        self,
        session_id: str,
        runtime: str,
        status: RuntimeStatus | None = None,
        selections: dict[str, str | None] | None = None,
        external_session_id: str | None = None,
        status_reason: str | None = None,
        error: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.session_state_updates.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "status": status,
                "selections": selections,
                "external_session_id": external_session_id,
                "status_reason": status_reason,
                "error": error,
                "metadata": metadata,
            }
        )

    async def timeline_item_upsert(self, item: RuntimeTimelineItem) -> None:
        self.timeline_item_upserts.append(item)

    async def notice_upsert(self, notice: Any) -> None:
        self.notice_upserts.append(notice)

    async def attachment_download(
        self,
        session_id: str,
        file_id: str,
    ) -> RuntimeAttachmentContent:
        _ = session_id
        return self.attachments[file_id]

    async def sync_state_read(self, key: str) -> dict[str, Any] | None:
        return self.sync_states.get(key)

    async def sync_state_write(self, key: str, value: dict[str, Any]) -> None:
        self.sync_states[key] = value

    async def sync_state_delete(self, key: str) -> None:
        self.sync_states.pop(key, None)


class _PermissionResultAllow:
    def __init__(self, behavior: str = "allow") -> None:
        self.behavior = behavior


class _PermissionResultDeny:
    def __init__(self, behavior: str = "deny", message: str = "") -> None:
        self.behavior = behavior
        self.message = message


async def _wait_until(predicate: Any) -> None:
    for _ in range(20):
        if predicate():
            return
        await asyncio.sleep(0)
    assert predicate()
