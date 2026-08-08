from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeConfig,
    RuntimeHostClient,
    RuntimeStatus,
    RuntimeTimelineItem,
)
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
    assert capabilities["session.interrupt"].supported is True
    assert capabilities["session.interrupt"].available is True
    assert capabilities["session.interaction.approval"].supported is True
    assert capabilities["session.interaction.approval"].available is True
    assert capabilities["runtime.attachment"].supported is False


def test_claude_runtime_empty_reads_are_stable() -> None:
    asyncio.run(_test_claude_runtime_empty_reads_are_stable())


async def _test_claude_runtime_empty_reads_are_stable() -> None:
    runtime = _runtime()

    assert await runtime.list_sessions() == ()
    assert (await runtime.list_model_catalog()).models == ()
    assert (await runtime.list_permission_catalog()).permissions == ()


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


def test_claude_runtime_rejects_attachments_until_supported() -> None:
    asyncio.run(_test_claude_runtime_rejects_attachments_until_supported())


async def _test_claude_runtime_rejects_attachments_until_supported() -> None:
    host = _RecordingHost()
    runtime = _runtime(host=host)

    result = await runtime.start_turn(
        "sess_attachments",
        None,
        "hello",
        attachments=(RuntimeAttachment(file_id="file_1"),),
    )

    assert result.ok is False
    assert result.code == "claude_attachments_unsupported"
    assert host.timeline_item_upserts == []


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
) -> ClaudeRuntime:
    active_host = host or _RecordingHost()
    active_client = client or _FakeClaudeClient()

    def client_factory(sdk: Any, options: Any) -> _FakeClaudeClient:
        _ = sdk
        active_client.options = options
        return active_client

    return ClaudeRuntime(
        config=_config(),
        host=active_host,
        sdk_loader=lambda: SimpleNamespace(
            __version__="1.0",
            ClaudeAgentOptions=_FakeOptions,
            PermissionResultAllow=_PermissionResultAllow,
            PermissionResultDeny=_PermissionResultDeny,
        ),
        client_factory=client_factory,
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


class _RecordingHost(RuntimeHostClient):
    def __init__(self) -> None:
        self.session_meta_upserts: list[dict[str, Any]] = []
        self.session_state_updates: list[dict[str, Any]] = []
        self.timeline_item_upserts: list[RuntimeTimelineItem] = []
        self.notice_upserts: list[Any] = []

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
