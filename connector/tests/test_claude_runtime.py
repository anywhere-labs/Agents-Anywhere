from __future__ import annotations

import asyncio
from collections.abc import Mapping
from types import SimpleNamespace
from typing import Any

from connector.runtime_protocol import RuntimeAttachmentContent, RuntimeConfig
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.runtime import ClaudeRuntime
from connector.runtimes.claude.utils import stable_session_id


class SimpleNamespaceOptions:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


class FakeClaudeSdk:
    ClaudeAgentOptions = SimpleNamespaceOptions
    ClaudeSDKClient = None

    class PermissionResultAllow:
        def __init__(self, updated_input: Mapping[str, Any]) -> None:
            self.updated_input = dict(updated_input)

    class PermissionResultDeny:
        def __init__(self, message: str) -> None:
            self.message = message

    @staticmethod
    def list_sessions(limit: int = 100) -> list[Any]:
        _ = limit
        return [
            SimpleNamespace(
                session_id="claude_session_1",
                custom_title="Fix Claude",
                summary=None,
                cwd="/repo",
                last_modified=1_785_628_800_000,
            )
        ]

    @staticmethod
    def get_session_info(session_id: str, directory: str | None = None) -> Any:
        _ = directory
        return SimpleNamespace(
            session_id=session_id,
            cwd="/repo",
            last_modified=1_785_628_800_000,
        )

    @staticmethod
    def get_session_messages(
        session_id: str, directory: str | None = None
    ) -> list[Any]:
        _ = directory
        return [
            SimpleNamespace(
                uuid="msg_user",
                session_id=session_id,
                type="user",
                message={"role": "user", "content": "hello"},
            ),
            SimpleNamespace(
                uuid="msg_assistant",
                session_id=session_id,
                type="assistant",
                message={
                    "role": "assistant",
                    "content": [{"type": "text", "text": "hi"}],
                },
            ),
        ]


class FakeClaudeClient:
    def __init__(self, messages: list[Any] | None = None) -> None:
        self.connected = False
        self.disconnected = False
        self.interrupted = False
        self.queries: list[Any] = []
        self.messages = messages or [
            SimpleNamespace(
                uuid="live_assistant",
                session_id="claude_live_1",
                type="assistant",
                message={"role": "assistant", "content": "done"},
            )
        ]

    async def connect(self) -> None:
        self.connected = True

    async def disconnect(self) -> None:
        self.disconnected = True

    async def query(self, stream: Any) -> None:
        collected = []
        async for item in stream:
            collected.append(item)
        self.queries.append(collected)

    async def receive_response(self) -> list[Any]:
        return self.messages

    async def interrupt(self) -> None:
        self.interrupted = True


class FakeHost(RuntimeHostClient):
    def __init__(self) -> None:
        self.meta_upserts: list[dict[str, Any]] = []
        self.state_updates: list[dict[str, Any]] = []
        self.timeline_item_upserts: list[Any] = []
        self.notice_upserts: list[Any] = []
        self.downloads: list[tuple[str, str]] = []

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
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.meta_upserts.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "external_session_id": external_session_id,
                "title": title,
                "cwd": cwd,
                "ordering_time": ordering_time,
                "metadata": dict(metadata or {}),
            }
        )

    async def session_state_update(
        self,
        session_id: str,
        runtime: str,
        status: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        external_session_id: str | None = None,
        status_reason: str | None = None,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.state_updates.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "status": status,
                "selections": dict(selections or {}),
                "external_session_id": external_session_id,
                "status_reason": status_reason,
                "error": dict(error) if error is not None else None,
                "metadata": dict(metadata or {}),
            }
        )

    async def timeline_item_upsert(self, item: Any) -> None:
        self.timeline_item_upserts.append(item)

    async def notice_upsert(self, notice: Any) -> None:
        self.notice_upserts.append(notice)

    async def attachment_download(
        self,
        session_id: str,
        file_id: str,
    ) -> RuntimeAttachmentContent:
        self.downloads.append((session_id, file_id))
        return RuntimeAttachmentContent(
            file_id=file_id,
            name="notes.txt",
            media_type="text/plain",
            content=b"hello\n",
        )


def test_claude_runtime_lifecycle_and_config() -> None:
    asyncio.run(_test_claude_runtime_lifecycle_and_config())


async def _test_claude_runtime_lifecycle_and_config() -> None:
    runtime = _runtime()

    assert runtime.identity.runtime == "claude"
    assert await runtime.get_config() == _config()

    await runtime.start()
    await runtime.stop()


def test_claude_runtime_permission_catalog() -> None:
    asyncio.run(_test_claude_runtime_permission_catalog())


async def _test_claude_runtime_permission_catalog() -> None:
    runtime = _runtime()

    catalog = await runtime.list_permission_catalog(query="bypass")

    assert [item.id for item in catalog.permissions] == ["bypassPermissions"]
    assert catalog.permissions[0].selection_id.startswith("sel_permission_")
    assert (
        catalog.permissions[0].metadata["nativeSettings"]["permissionMode"]
        == "bypassPermissions"
    )


def test_claude_runtime_lists_sessions_from_sdk() -> None:
    asyncio.run(_test_claude_runtime_lists_sessions_from_sdk())


async def _test_claude_runtime_lists_sessions_from_sdk() -> None:
    runtime = _runtime()

    sessions = await runtime.list_sessions()

    assert len(sessions) == 1
    assert sessions[0].session_id == stable_session_id("conn_test", "claude_session_1")
    assert sessions[0].runtime == "claude"
    assert sessions[0].title == "Fix Claude"
    assert sessions[0].cwd == "/repo"
    assert sessions[0].ordering_time == "2026-08-02T00:00:00Z"


def test_claude_runtime_reads_session_snapshot() -> None:
    asyncio.run(_test_claude_runtime_reads_session_snapshot())


async def _test_claude_runtime_reads_session_snapshot() -> None:
    runtime = _runtime()

    snapshot = await runtime.get_session_snapshot("sess_1", "claude_session_1")

    assert snapshot.runtime == "claude"
    assert [item.role for item in snapshot.items] == ["user", "assistant"]
    assert snapshot.items[0].content == {"text": "hello", "format": "markdown"}
    assert snapshot.items[1].content == {"text": "hi", "format": "markdown"}


def test_claude_runtime_start_turn_emits_state_and_timeline() -> None:
    asyncio.run(_test_claude_runtime_start_turn_emits_state_and_timeline())


async def _test_claude_runtime_start_turn_emits_state_and_timeline() -> None:
    host = FakeHost()
    client = FakeClaudeClient()
    runtime = _runtime(host=host, client=client)

    result = await runtime.start_turn(
        "sess_1", "claude_session_1", "hello", client_message_id="cm_1"
    )
    await runtime._sessions["sess_1"].active_task

    assert result.ok is True
    assert [update["status"] for update in host.state_updates] == [
        "waiting",
        "running",
        "idle",
    ]
    assert client.connected is True
    assert client.disconnected is True
    assert client.queries[0][0]["message"]["content"] == "hello"
    assert [item.role for item in host.timeline_item_upserts] == ["user", "assistant"]
    assert host.timeline_item_upserts[0].source["clientMessageId"] == "cm_1"


def test_claude_runtime_interrupts_active_turn() -> None:
    asyncio.run(_test_claude_runtime_interrupts_active_turn())


async def _test_claude_runtime_interrupts_active_turn() -> None:
    host = FakeHost()
    release = asyncio.Event()
    client = BlockingClaudeClient(release)
    runtime = _runtime(host=host, client=client)

    await runtime.start_turn("sess_1", "claude_session_1", "hello")
    await asyncio.sleep(0)
    result = await runtime.interrupt_turn("sess_1", "claude_session_1", "user")

    assert result.ok is True
    assert result.result["interrupted"] is True
    assert client.interrupted is True
    assert host.state_updates[-1]["status"] == "idle"
    release.set()


def test_claude_runtime_projects_sdk_approval_to_notice() -> None:
    asyncio.run(_test_claude_runtime_projects_sdk_approval_to_notice())


async def _test_claude_runtime_projects_sdk_approval_to_notice() -> None:
    host = FakeHost()
    release = asyncio.Event()
    client = BlockingClaudeClient(release)
    captured_options: list[Any] = []

    def client_factory(_sdk: Any, options: Any) -> FakeClaudeClient:
        captured_options.append(options)
        return client

    runtime = ClaudeRuntime(
        config=_config(),
        host=host,
        sdk_loader=lambda: FakeClaudeSdk,
        client_factory=client_factory,
    )

    result = await runtime.start_turn(
        "sess_approval", "claude_session_approval", "hello"
    )
    await asyncio.sleep(0)

    can_use_tool = captured_options[0].kwargs["can_use_tool"]
    approval_task = asyncio.create_task(
        can_use_tool(
            "Bash", {"command": "ls"}, {"session_id": "claude_session_approval"}
        )
    )
    await asyncio.sleep(0)

    assert result.ok is True
    assert host.state_updates[-1]["status"] == "blocked"
    assert len(host.notice_upserts) == 1
    notice = host.notice_upserts[0]
    assert notice.type == "interaction"
    assert notice.interaction_type == "approval"
    assert notice.context["kind"] == "command"
    assert notice.context["toolName"] == "Bash"
    assert notice.context["turnId"] == result.result["turnId"]
    assert notice.context["approvalSource"]["requestId"] == notice.notice_id

    response = await runtime.respond_interaction(
        session_id="sess_approval",
        notice_id=notice.notice_id,
        action_id="approve",
    )
    permission = await approval_task

    assert response.ok is True
    assert isinstance(permission, FakeClaudeSdk.PermissionResultAllow)
    assert permission.updated_input == {"command": "ls"}
    assert len(host.notice_upserts) == 1
    assert host.state_updates[-1]["status"] == "running"
    release.set()
    await runtime._sessions["sess_approval"].active_task
    assert host.state_updates[-1]["status"] == "idle"


def test_claude_runtime_interrupt_rejects_pending_approval() -> None:
    asyncio.run(_test_claude_runtime_interrupt_rejects_pending_approval())


async def _test_claude_runtime_interrupt_rejects_pending_approval() -> None:
    host = FakeHost()
    release = asyncio.Event()
    client = BlockingClaudeClient(release)
    captured_options: list[Any] = []

    runtime = ClaudeRuntime(
        config=_config(),
        host=host,
        sdk_loader=lambda: FakeClaudeSdk,
        client_factory=lambda _sdk, options: captured_options.append(options) or client,
    )

    await runtime.start_turn("sess_approval", "claude_session_approval", "hello")
    await asyncio.sleep(0)
    approval_task = asyncio.create_task(
        captured_options[0].kwargs["can_use_tool"](
            "Bash",
            {"command": "rm -rf /tmp/x"},
            {"session_id": "claude_session_approval"},
        )
    )
    await asyncio.sleep(0)

    result = await runtime.interrupt_turn(
        "sess_approval", "claude_session_approval", "user"
    )
    permission = await approval_task

    assert result.ok is True
    assert isinstance(permission, FakeClaudeSdk.PermissionResultDeny)
    assert "denied" in permission.message
    release.set()


class BlockingClaudeClient(FakeClaudeClient):
    def __init__(self, release: asyncio.Event) -> None:
        super().__init__()
        self.release = release

    async def receive_response(self) -> list[Any]:
        await self.release.wait()
        return []


def _runtime(
    host: FakeHost | None = None,
    client: FakeClaudeClient | None = None,
) -> ClaudeRuntime:
    return ClaudeRuntime(
        config=_config(),
        host=host or FakeHost(),
        sdk_loader=lambda: FakeClaudeSdk,
        client_factory=lambda _sdk, _options: client or FakeClaudeClient(),
    )


def _config() -> RuntimeConfig:
    return RuntimeConfig(
        runtime="claude",
        revision=1,
        values={"environment": {}},
    )
