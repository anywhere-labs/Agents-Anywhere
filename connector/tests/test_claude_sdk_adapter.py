from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from typing import Any

import pytest

import connector.claude.sdk_adapter as sdk_adapter_module
from connector.claude.sdk_adapter import ClaudeSdkAdapter
from connector.claude.path_utils import encode_cwd
from connector.launch import launch_target


@dataclass
class FakeTextBlock:
    text: str
    type: str = "text"


@dataclass
class FakeToolUseBlock:
    id: str
    name: str
    input: dict[str, Any]
    type: str = "tool_use"


@dataclass
class FakeAssistantMessage:
    id: str
    content: list[Any]
    role: str = "assistant"


@dataclass
class FakeSystemMessage:
    subtype: str
    data: dict[str, Any]


@dataclass
class FakeResultMessage:
    session_id: str
    subtype: str = "success"
    result: str = "ok"


@dataclass
class StreamEvent:
    event: dict[str, Any]
    session_id: str
    uuid: str = "stream_event_uuid"


class FakeOptions:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


class FakeAllow:
    def __init__(self, *, updated_input):
        self.updated_input = updated_input


class FakeDeny:
    def __init__(self, *, message):
        self.message = message


class FakeHookMatcher:
    def __init__(self, *, matcher, hooks):
        self.matcher = matcher
        self.hooks = hooks


class FakeClient:
    instances: list["FakeClient"] = []

    def __init__(self, *, options):
        self.options = options
        self.connected = False
        self.queries: list[Any] = []
        self.interrupted = False
        FakeClient.instances.append(self)

    async def connect(self):
        self.connected = True

    async def query(self, prompt):
        self.queries.append(prompt)

    async def receive_response(self):
        yield FakeAssistantMessage(
            id="msg_assistant_1",
            content=[
                FakeTextBlock(text="I'll run that."),
                FakeToolUseBlock(id="toolu_1", name="Bash", input={"command": "pytest -q"}),
            ],
        )
        yield FakeResultMessage(session_id="claude_session_1")

    async def interrupt(self):
        self.interrupted = True


class FailingClient(FakeClient):
    async def connect(self):
        stderr = self.options.kwargs.get("stderr")
        if stderr:
            stderr("Error: auth_token=secret-token")
            stderr("real failure detail")
        raise RuntimeError("Command failed with exit code 1")


class SystemThenAssistantClient(FakeClient):
    async def receive_response(self):
        yield FakeSystemMessage(subtype="init", data={})
        yield FakeAssistantMessage(
            id="msg_assistant_after_system",
            content=[FakeTextBlock(text="still streaming")],
        )
        yield FakeResultMessage(session_id="claude_session_system")


class StreamingDeltaClient(FakeClient):
    async def receive_response(self):
        yield StreamEvent(
            event={"type": "message_start", "message": {"id": "msg_stream_1"}},
            session_id="claude_session_stream",
        )
        yield StreamEvent(
            event={
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "Hel"},
            },
            session_id="claude_session_stream",
        )
        yield StreamEvent(
            event={
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": "lo"},
            },
            session_id="claude_session_stream",
        )
        yield FakeResultMessage(session_id="claude_session_stream")


class BlockingClient(FakeClient):
    started: asyncio.Event
    release: asyncio.Event

    async def receive_response(self):
        self.started.set()
        await self.release.wait()
        yield FakeResultMessage(session_id="claude_session_live")


class FakeSdk:
    ClaudeAgentOptions = FakeOptions
    ClaudeSDKClient = FakeClient
    HookMatcher = FakeHookMatcher
    PermissionResultAllow = FakeAllow
    PermissionResultDeny = FakeDeny


@pytest.mark.anyio
async def test_claude_sdk_adapter_streams_timeline_and_updates_external_session(tmp_path, monkeypatch):
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def sink(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    project_dir = tmp_path / encode_cwd("/repo")
    project_dir.mkdir(parents=True)
    transcript = project_dir / "claude_session_1.jsonl"
    transcript.write_text('{"type":"result"}\n', encoding="utf-8")
    monkeypatch.setattr(sdk_adapter_module, "projects_root", lambda: tmp_path)

    FakeClient.instances = []
    adapter = ClaudeSdkAdapter(notification_sink=sink, sdk_module=FakeSdk)
    adapter.claude_target = launch_target("custom", "/opt/claude")
    adapter.transcript_adapter.projects_dir = tmp_path

    created = await adapter.create_session({"sessionId": "sess_1", "cwd": "/repo"})
    started = await adapter.start_turn(
        {
            "sessionId": "sess_1",
            "cwd": "/repo",
            "content": "Run tests",
            "clientMessageId": "opt_1",
            "permissionMode": "acceptEdits",
            "model": "claude-sonnet-4-6",
            "effort": "high",
            "attachments": [
                {
                    "fileId": "file_1",
                    "name": "report.txt",
                    "mediaType": "text/plain",
                    "size": 12,
                    "sha256": "abc",
                    "downloadUrl": "/sessions/sess_1/fs/downloads/file_1",
                    "pathHint": "/repo/.aa-attachments/file_1-report.txt",
                }
            ],
        }
    )
    await adapter._sessions["sess_1"].active_task

    assert created == {"sessionId": "sess_1", "externalSessionId": None, "backendNotifications": []}
    assert started["turnId"].startswith("turn_claude_")
    client = FakeClient.instances[-1]
    assert client.connected is True
    assert client.options.kwargs["cwd"] == "/repo"
    assert client.options.kwargs["cli_path"] == "/opt/claude"
    assert client.options.kwargs["permission_mode"] == "acceptEdits"
    assert client.options.kwargs["model"] == "claude-sonnet-4-6"
    assert client.options.kwargs["effort"] == "high"
    assert client.options.kwargs["include_partial_messages"] is True
    assert "can_use_tool" in client.options.kwargs
    assert "hooks" in client.options.kwargs

    timeline = [params["item"] for method, params in notifications if method == "timeline.itemUpsert"]
    assert [item["type"] for item in timeline] == [
        "turn.start",
        "message",
        "message",
        "tool",
        "turn.end",
    ]
    assert timeline[1]["id"].startswith("claude_msg_")
    assert not timeline[1]["id"].startswith(started["turnId"])
    assert timeline[1]["source"]["clientMessageId"] == "opt_1"
    assert timeline[1]["content"]["attachments"] == [
        {
            "fileId": "file_1",
            "name": "report.txt",
            "mediaType": "text/plain",
            "size": 12,
            "sha256": "abc",
            "downloadUrl": "/sessions/sess_1/fs/downloads/file_1",
        }
    ]
    assert timeline[2]["content"]["text"] == "I'll run that."
    assert timeline[3]["content"]["toolName"] == "Bash"
    assert timeline[-1]["status"] == "done"

    updates = [params for method, params in notifications if method == "session.updated"]
    assert any(update["externalSessionId"] == "claude_session_1" for update in updates)
    cursor_updates = [
        params
        for method, params in notifications
        if method == "claude.transcriptCursorAdvanced"
    ]
    assert cursor_updates == [
        {
            "sessionId": "sess_1",
            "runtime": "claude",
            "externalSessionId": "claude_session_1",
            "transcriptPath": str(transcript),
            "lastOffset": transcript.stat().st_size,
            "lastEventKey": started["turnId"],
        }
    ]
    cursor = adapter.transcript_adapter._cursors[transcript]
    assert cursor.offset == transcript.stat().st_size

    sync_notifications: list[list[dict[str, Any]]] = []

    async def sync_sink(notifications: list[dict[str, Any]]) -> None:
        sync_notifications.append(notifications)

    sync_result = await adapter.sync_existing_sessions("conn_x", notification_sink=sync_sink)
    assert sync_result["threads"] == []
    assert sync_notifications == []

    prompt = client.queries[0]
    yielded = []
    async for item in prompt:
        yielded.append(item)
    assert yielded == [
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Run tests"},
                    {
                        "type": "text",
                        "text": "\n\nAttached file: /repo/.aa-attachments/file_1-report.txt",
                    },
                ],
            },
        }
    ]


@pytest.mark.anyio
async def test_claude_sdk_adapter_skips_live_transcript_scan_without_cursor_advance(tmp_path, monkeypatch):
    project_dir = tmp_path / encode_cwd("/repo")
    project_dir.mkdir(parents=True)
    transcript = project_dir / "claude_session_live.jsonl"
    transcript.write_text(
        '{"type":"user","uuid":"u-live","message":{"content":"hi"},"cwd":"/repo"}\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(sdk_adapter_module, "projects_root", lambda: tmp_path)

    class BlockingSdk(FakeSdk):
        ClaudeSDKClient = BlockingClient

    BlockingClient.instances = []
    BlockingClient.started = asyncio.Event()
    BlockingClient.release = asyncio.Event()
    adapter = ClaudeSdkAdapter(sdk_module=BlockingSdk)
    adapter.transcript_adapter.projects_dir = tmp_path

    await adapter.start_turn(
        {
            "sessionId": "sess_live",
            "cwd": "/repo",
            "externalSessionId": "claude_session_live",
            "content": "hi",
        }
    )
    await BlockingClient.started.wait()

    sync_notifications: list[list[dict[str, Any]]] = []

    async def sync_sink(notifications: list[dict[str, Any]]) -> None:
        sync_notifications.append(notifications)

    sync_result = await adapter.sync_existing_sessions("conn_x", notification_sink=sync_sink)
    assert sync_result["threads"] == []
    assert sync_result["skippedThreads"] == ["claude_session_live"]
    assert sync_notifications == []
    assert transcript not in adapter.transcript_adapter._cursors

    BlockingClient.release.set()
    await adapter._sessions["sess_live"].active_task


@pytest.mark.anyio
async def test_claude_sdk_adapter_does_not_treat_system_subtype_as_result():
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def sink(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    class SystemSdk(FakeSdk):
        ClaudeSDKClient = SystemThenAssistantClient

    adapter = ClaudeSdkAdapter(notification_sink=sink, sdk_module=SystemSdk)

    started = await adapter.start_turn(
        {
            "sessionId": "sess_system",
            "cwd": "/repo",
            "externalSessionId": "claude_session_system",
            "content": "hi",
            "clientMessageId": "opt_system",
        }
    )
    await adapter._sessions["sess_system"].active_task

    timeline = [params["item"] for method, params in notifications if method == "timeline.itemUpsert"]
    assert [item["type"] for item in timeline] == [
        "turn.start",
        "message",
        "message",
        "turn.end",
    ]
    assert timeline[1]["role"] == "user"
    assert timeline[1]["source"]["clientMessageId"] == "opt_system"
    assert timeline[2]["role"] == "assistant"
    assert timeline[2]["content"]["text"] == "still streaming"
    assert timeline[-1]["turnId"] == started["turnId"]


@pytest.mark.anyio
async def test_claude_sdk_adapter_versions_live_stream_message_snapshots():
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def sink(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    class StreamingSdk(FakeSdk):
        ClaudeSDKClient = StreamingDeltaClient

    adapter = ClaudeSdkAdapter(notification_sink=sink, sdk_module=StreamingSdk)

    await adapter.start_turn(
        {
            "sessionId": "sess_stream",
            "cwd": "/repo",
            "externalSessionId": "claude_session_stream",
            "content": "say hello",
        }
    )
    await adapter._sessions["sess_stream"].active_task

    timeline = [params["item"] for method, params in notifications if method == "timeline.itemUpsert"]
    assistant = [
        item
        for item in timeline
        if item["type"] == "message" and item.get("role") == "assistant"
    ]

    assert assistant[0]["id"].startswith("claude_msg_")
    assert len({item["id"] for item in assistant}) == 1
    assert [item["content"]["text"] for item in assistant] == ["Hel", "Hello", "Hello"]
    assert [item["revision"] for item in assistant] == [1, 2, 3]
    assert [item["status"] for item in assistant] == ["running", "running", "done"]
    assert assistant[0]["orderSeq"] == assistant[1]["orderSeq"] == assistant[2]["orderSeq"]
    assert assistant[0]["createdAt"] == assistant[1]["createdAt"] == assistant[2]["createdAt"]
    assert assistant[-1]["completedAt"]


@pytest.mark.anyio
async def test_claude_sdk_adapter_approval_bridge_resolves_to_sdk_allow():
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def sink(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    adapter = ClaudeSdkAdapter(notification_sink=sink, sdk_module=FakeSdk)
    runtime = adapter._runtime_for(
        "sess_approval",
        {"sessionId": "sess_approval", "externalSessionId": "claude_session_approval"},
    )
    runtime.active_turn_id = "turn_approval"

    task = asyncio.create_task(
        adapter._can_use_tool("Bash", {"command": "ls"}, {"session_id": "claude_session_approval"})
    )
    await asyncio.sleep(0)

    approvals = [params for method, params in notifications if method == "approval.requested"]
    assert len(approvals) == 1
    assert approvals[0]["kind"] == "command"
    result = await adapter.resolve_approval(
        {
            "sessionId": "sess_approval",
            "approvalId": approvals[0]["id"],
            "status": "approved",
        }
    )
    permission = await task

    assert result == {"resolved": True}
    assert isinstance(permission, FakeAllow)
    assert permission.updated_input == {"command": "ls"}


@pytest.mark.anyio
async def test_claude_sdk_adapter_materializes_file_attachment_to_user_dir(tmp_path, monkeypatch):
    FakeClient.instances = []
    workspace = tmp_path / "repo"
    workspace.mkdir()
    attachments_root = tmp_path / "runtime-attachments"
    monkeypatch.setenv("AGENT_CONNECTOR_ATTACHMENTS_ROOT", str(attachments_root))
    adapter = ClaudeSdkAdapter(sdk_module=FakeSdk)

    async def download(file_id: str) -> tuple[bytes, str, str]:
        assert file_id == "file_1"
        return b"hello\n", "../notes.md", "text/markdown"

    adapter.attachment_downloader = download

    await adapter.create_session({"sessionId": "sess_file", "cwd": str(workspace)})
    await adapter.start_turn(
        {
            "sessionId": "sess_file",
            "cwd": str(workspace),
            "content": "Read this",
            "attachments": [{"fileId": "file_1", "name": "../notes.md"}],
        }
    )
    await adapter._sessions["sess_file"].active_task

    materialized = attachments_root / "sess_file" / "file_1-notes.md"
    assert materialized.read_bytes() == b"hello\n"
    prompt = FakeClient.instances[-1].queries[0]
    yielded = []
    async for item in prompt:
        yielded.append(item)
    assert yielded[0]["message"]["content"] == [
        {"type": "text", "text": "Read this"},
        {
            "type": "text",
            "text": (
                f"\n\n[Attached file: ../notes.md (text/markdown, 6 bytes) at"
                f" {materialized}]"
            ),
        },
    ]


@pytest.mark.anyio
async def test_claude_sdk_adapter_sends_image_attachment_as_base64_block(tmp_path, monkeypatch):
    FakeClient.instances = []
    workspace = tmp_path / "repo"
    workspace.mkdir()
    attachments_root = tmp_path / "runtime-attachments"
    monkeypatch.setenv("AGENT_CONNECTOR_ATTACHMENTS_ROOT", str(attachments_root))
    adapter = ClaudeSdkAdapter(sdk_module=FakeSdk)
    image_bytes = b"\x89PNG\r\n\x1a\n"

    async def download(file_id: str) -> tuple[bytes, str, str]:
        assert file_id == "file_img"
        return image_bytes, "diagram.png", "image/png"

    adapter.attachment_downloader = download

    await adapter.create_session({"sessionId": "sess_image", "cwd": str(workspace)})
    await adapter.start_turn(
        {
            "sessionId": "sess_image",
            "cwd": str(workspace),
            "content": "Review diagram",
            "attachments": [{"fileId": "file_img", "name": "diagram.png"}],
        }
    )
    await adapter._sessions["sess_image"].active_task

    materialized = attachments_root / "sess_image" / "file_img-diagram.png"
    assert materialized.read_bytes() == image_bytes
    prompt = FakeClient.instances[-1].queries[0]
    yielded = []
    async for item in prompt:
        yielded.append(item)
    content = yielded[0]["message"]["content"]
    assert content[0] == {"type": "text", "text": "Review diagram"}
    assert content[1] == {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": base64.b64encode(image_bytes).decode("ascii"),
        },
    }
    assert content[2] == {"type": "text", "text": f"\n\nAttached image: diagram.png at {materialized}"}


@pytest.mark.anyio
async def test_claude_sdk_adapter_interrupt_calls_sdk_client():
    adapter = ClaudeSdkAdapter(sdk_module=FakeSdk)
    runtime = adapter._runtime_for("sess_interrupt", {"sessionId": "sess_interrupt"})
    client = FakeClient(options=FakeOptions())
    runtime.client = client

    result = await adapter.interrupt_turn({"sessionId": "sess_interrupt"})

    assert result == {"interrupted": True}
    assert client.interrupted is True


@pytest.mark.anyio
async def test_claude_sdk_adapter_surfaces_stderr_on_turn_failure():
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def sink(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    class FailingSdk(FakeSdk):
        ClaudeSDKClient = FailingClient

    adapter = ClaudeSdkAdapter(notification_sink=sink, sdk_module=FailingSdk)
    await adapter.start_turn(
        {
            "sessionId": "sess_fail",
            "cwd": "/repo",
            "externalSessionId": "claude_session_fail",
            "content": "hi",
            "model": "claude-opus-4-8[1M]",
            "effort": "xhigh",
            "permissionMode": "bypassPermissions",
        }
    )
    await adapter._sessions["sess_fail"].active_task

    timeline = [params["item"] for method, params in notifications if method == "timeline.itemUpsert"]
    assert timeline[-1]["type"] == "turn.end"
    assert timeline[-1]["status"] == "failed"
    assert "real failure detail" in timeline[-1]["content"]["stopReason"]
    assert "secret-token" not in timeline[-1]["content"]["stopReason"]
    errors = [params for method, params in notifications if method == "runtime.error"]
    assert errors
    assert errors[-1]["stderr"] == "Error: auth_token=***\nreal failure detail"
    assert "real failure detail" in errors[-1]["message"]
