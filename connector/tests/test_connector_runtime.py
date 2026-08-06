from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import sys
from collections.abc import Mapping
from typing import Any, Self

import pytest
from websockets.exceptions import ConnectionClosedError
from websockets.frames import Close

from connector.core.config import ConnectorConfig
from connector.local.terminal import TerminalBackend
from connector.runtime_protocol import (
    AgentRuntime,
    ArtifactTimelineContent,
    ArtifactTimelineItem,
    CommandToolContent,
    ErrorSystemContent,
    FileArtifactContent,
    FileChangeToolContent,
    GenericMarkerContent,
    MarkdownMessageContent,
    MarkerTimelineItem,
    MessageTimelineContent,
    MessageTimelineItem,
    PlatformTimelineItem,
    ReasoningSystemContent,
    RuntimeAttachmentContent,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeIdentity,
    RuntimeInventoryItem,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
    RuntimeProvider,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionNotice,
    SessionState,
    SystemTimelineContent,
    SystemTimelineItem,
    TimelineSource,
    ToolTimelineContent,
    ToolTimelineItem,
    TurnEndTimelineItem,
    TurnStartTimelineItem,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes import default_runtime_providers
from connector.runtimes.claude.provider import ClaudeProvider
from connector.runtimes.codex.provider import CodexProvider
from connector.server.auth import ConnectorAuthenticationError
from connector.server.capabilities import protocol_capabilities_from_inventory
from connector.server.client import BackendRpcClient
from connector.server.ingest import coalesce_timeline_item_upserts
from connector.server.runtime_sync import RuntimeSyncRunner


def test_platform_timeline_item_converts_to_runtime_wire_item() -> None:
    item = PlatformTimelineItem(
        id="item_1",
        type="message",
        status="done",
        role="assistant",
        turn_id="turn_1",
        content=MessageTimelineContent(text="hello"),
        source=TimelineSource(
            runtime="codex",
            external_session_id="thread_1",
            turn_id="turn_1",
            native_item_id="native_1",
            native_item_type="agentMessage",
            event="thread/read",
        ),
        revision=2,
    )

    wire_item = item.to_platform_item(session_id="sess_1", order_seq=7)

    assert wire_item == RuntimeTimelineItem(
        id="item_1",
        session_id="sess_1",
        type="message",
        status="done",
        order_seq=7,
        content_hash=wire_item.content_hash,
        role="assistant",
        turn_id="turn_1",
        content={"kind": "markdown", "text": "hello", "format": "markdown"},
        source={
            "runtime": "codex",
            "sessionId": "thread_1",
            "turnId": "turn_1",
            "itemId": "native_1",
            "itemType": "agentMessage",
            "event": "thread/read",
        },
        revision=2,
    )
    assert wire_item.content_hash.startswith("sha256:")


def test_tool_timeline_content_serializes_supported_parent_shape() -> None:
    content = ToolTimelineContent(
        kind="command",
        title="Run tests",
        command="pytest",
        output="ok",
        exit_code=0,
    )

    assert content.to_mapping() == {
        "kind": "command",
        "title": "Run tests",
        "command": "pytest",
        "output": "ok",
        "exitCode": 0,
    }


def test_specific_timeline_content_classes_lock_content_kind() -> None:
    message = MarkdownMessageContent(text="hello")
    command = CommandToolContent(command="pytest", output="ok")
    file_change = FileChangeToolContent(metadata={"tool": "apply_patch"})
    artifact = FileArtifactContent(path="/tmp/example.py")
    reasoning = ReasoningSystemContent(text="thinking")
    error = ErrorSystemContent(message="boom", severity="error")

    assert message.to_mapping() == {
        "kind": "markdown",
        "text": "hello",
        "format": "markdown",
    }
    assert command.to_mapping() == {
        "kind": "command",
        "command": "pytest",
        "output": "ok",
    }
    assert file_change.to_mapping() == {
        "kind": "file_change",
        "tool": "apply_patch",
    }
    assert artifact.to_mapping() == {
        "kind": "file",
        "path": "/tmp/example.py",
    }
    assert reasoning.to_mapping() == {
        "kind": "reasoning",
        "text": "thinking",
    }
    assert error.to_mapping() == {
        "kind": "error",
        "message": "boom",
        "severity": "error",
    }

    with pytest.raises(ValueError, match="requires kind='command'"):
        CommandToolContent(kind="tool_call")


def test_platform_timeline_item_subclasses_validate_parent_type() -> None:
    source = TimelineSource(runtime="test")

    MessageTimelineItem(
        id="message_1",
        type="message",
        status="done",
        role="assistant",
        content=MessageTimelineContent(text="ok"),
        source=source,
    )
    ToolTimelineItem(
        id="tool_1",
        type="tool",
        status="done",
        role="tool",
        content=ToolTimelineContent(kind="command"),
        source=source,
    )
    ArtifactTimelineItem(
        id="artifact_1",
        type="artifact",
        status="done",
        content=ArtifactTimelineContent(kind="file"),
        source=source,
    )
    MarkerTimelineItem(
        id="marker_1",
        type="marker",
        status="done",
        role="system",
        content=GenericMarkerContent(label="Checkpoint"),
        source=source,
    )
    SystemTimelineItem(
        id="system_1",
        type="system",
        status="done",
        role="system",
        content=SystemTimelineContent(kind="runtime"),
        source=source,
    )
    TurnStartTimelineItem(
        id="turn_start_1",
        type="turn.start",
        status="running",
        content=SystemTimelineContent(kind="runtime"),
        source=source,
    )
    TurnEndTimelineItem(
        id="turn_end_1",
        type="turn.end",
        status="done",
        content=SystemTimelineContent(kind="runtime"),
        source=source,
    )


class FakeAgentRuntime(AgentRuntime):
    def __init__(self, runtime_id: str = "codex") -> None:
        self.runtime_id = runtime_id
        self.started = False
        self.stopped = False
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.config: RuntimeConfig | None = None

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(runtime=self.runtime_id, runtime_version="test")

    async def start(self) -> None:
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    async def get_config(self) -> RuntimeConfig:
        if self.config is None:
            return RuntimeConfig(runtime=self.runtime_id, revision=0, values={})
        return self.config

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        self.calls.append(
            (
                "session.discover",
                {
                    "limit": limit,
                    "cursor": cursor,
                    "force": force,
                },
            )
        )
        return (
            SessionMeta(
                session_id="sess_existing",
                external_session_id="thr_existing",
                runtime=self.runtime_id,
                title="Existing",
                cwd="/repo",
                ordering_time="2026-08-02T00:00:00Z",
            ),
        )

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        self.calls.append(("runtime.modelCatalog", {"query": query, "limit": limit}))
        return RuntimeModelCatalog(
            runtime=self.runtime_id,
            revision=7,
            models=(
                RuntimeModelItem(
                    id="gpt-test",
                    title="GPT Test",
                    selection_id="sel_model_test",
                    description="Test model",
                ),
            ),
        )

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        self.calls.append(("runtime.permissionCatalog", {"query": query, "limit": limit}))
        return RuntimePermissionCatalog(
            runtime=self.runtime_id,
            revision=8,
            permissions=(
                RuntimePermissionItem(
                    id="read-only",
                    title="Read only",
                    selection_id="sel_permission_readonly",
                ),
            ),
        )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int = 100,
    ) -> RuntimeTimelineSnapshot:
        self.calls.append(
            (
                "session.sync",
                {
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                    "limit": limit,
                },
            )
        )
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime=self.runtime_id,
            items=(
                RuntimeTimelineItem(
                    id="item_1",
                    session_id=session_id,
                    type="message",
                    status="done",
                    order_seq=1,
                    content_hash="sha256:item",
                    role="assistant",
                    content={"text": "hello", "format": "markdown"},
                    source={"runtime": self.runtime_id, "event": "test"},
                ),
            ),
        )

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState:
        self.calls.append(
            (
                "session.state",
                {
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                },
            )
        )
        return SessionState(
            session_id=session_id,
            runtime=self.runtime_id,
            external_session_id=external_session_id,
            status="running",
            selections={"model": "sel_model_state"},
            metadata={"source": "fake"},
        )

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        self.calls.append(
            (
                "session.notices",
                {
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                },
            )
        )
        return (
            SessionNotice(
                notice_id="notice_1",
                session_id=session_id,
                runtime=self.runtime_id,
                type="interaction",
                title="Approval required",
                status="open",
                interaction_type="approval",
                response_required=True,
                actions=({"actionId": "approve", "label": "Approve"},),
            ),
        )

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        self.calls.append(("runtime.capabilities", {}))
        return RuntimeCapabilitySet(
            runtime=self.runtime_id,
            revision=9,
            capabilities=(
                RuntimeCapability(
                    capability_id="runtime.config",
                    scope="runtime",
                    runtime=self.runtime_id,
                ),
            ),
        )

    async def list_runtime_commands(self, limit: int = 100) -> tuple[RuntimeCommand, ...]:
        self.calls.append(("runtime.commands", {"limit": limit}))
        return (
            RuntimeCommand(
                id="runtime-status",
                title="Runtime status",
                scope="runtime",
            ),
        )

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        self.calls.append(
            (
                "session.capabilities",
                {
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                },
            )
        )
        return RuntimeCapabilitySet(
            runtime=self.runtime_id,
            revision=10,
            session_id=session_id,
            capabilities=(
                RuntimeCapability(
                    capability_id="session.interrupt",
                    scope="session",
                    runtime=self.runtime_id,
                    session_id=session_id,
                    available=False,
                    unavailable_reason="session_not_running",
                ),
            ),
        )

    async def list_commands(
        self,
        session_id: str,
        external_session_id: str | None = None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RuntimeCommand, ...]:
        self.calls.append(
            (
                "session.commands",
                {
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                    "query": query,
                    "limit": limit,
                },
            )
        )
        return (
            RuntimeCommand(
                id="resume",
                title="Resume",
                description="Resume the current turn.",
                aliases=("continue",),
                category="session",
                accepts_args=False,
            ),
        )

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        self.calls.append(
            (
                "session.command.execute",
                {
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                    "command": command,
                    "raw": raw,
                    "args": list(args),
                },
            )
        )
        return RuntimeCommandResult(
            command=command,
            ok=True,
            message="Command executed.",
            result={"sessionId": session_id},
        )

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: dict[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        self.calls.append(
            (
                "interaction.respond",
                {
                    "sessionId": session_id,
                    "noticeId": notice_id,
                    "actionId": action_id,
                    "inputData": dict(input_data or {}),
                },
            )
        )
        return RuntimeOperationResult(
            ok=True,
            result={"resolved": True, "noticeId": notice_id},
        )

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections=None,  # type: ignore[no-untyped-def]
        attachments=(),  # type: ignore[no-untyped-def]
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        self.calls.append(
            (
                "session.create",
                {
                    "sessionId": session_id,
                    "content": content,
                    "title": title,
                    "cwd": cwd,
                    "selections": dict(selections or {}),
                    "attachments": attachments,
                    "clientMessageId": client_message_id,
                },
            )
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "sessionId": session_id,
                "externalSessionId": "thr_created",
                "turnId": "turn_agent",
            },
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections=None,  # type: ignore[no-untyped-def]
        attachments=(),  # type: ignore[no-untyped-def]
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        self.calls.append(
            (
                "turn.start",
                {
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                    "content": content,
                    "selections": dict(selections or {}),
                    "attachments": attachments,
                    "clientMessageId": client_message_id,
                },
            )
        )
        return RuntimeOperationResult(ok=True, result={"turnId": "turn_agent"})

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments=(),  # type: ignore[no-untyped-def]
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        self.calls.append(
            (
                "turn.steer",
                {
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                    "content": content,
                    "attachments": attachments,
                    "clientMessageId": client_message_id,
                },
            )
        )
        return RuntimeOperationResult(ok=True, result={"steered": True, "turnId": "turn_agent"})

    async def interrupt_turn(
        self,
        session_id: str,
        external_session_id: str | None = None,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        self.calls.append(
            (
                "turn.interrupt",
                {
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                    "reason": reason,
                },
            )
        )
        return RuntimeOperationResult(ok=True, result={"interrupted": True, "turnId": "turn_agent"})

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: dict[str, str | None],
    ) -> RuntimeOperationResult:
        self.calls.append(
            (
                "session.selections.update",
                {
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                    "selections": dict(selections),
                },
            )
        )
        return RuntimeOperationResult(ok=True, result={"updated": True})


class FakeAgentProvider(RuntimeProvider):
    def __init__(self, runtime: FakeAgentRuntime, runtime_id: str = "codex") -> None:
        self._runtime = runtime
        self._runtime_id = runtime_id

    @property
    def runtime(self) -> str:
        return self._runtime_id

    @property
    def runtime_type(self) -> str:
        return self._runtime_id

    @property
    def display_name(self) -> str:
        return self._runtime_id.title()

    async def discover(self) -> RuntimeInventoryItem:
        return RuntimeInventoryItem(
            runtime=self._runtime_id,
            runtime_type=self._runtime_id,
            display_name=self.display_name,
            available=True,
            configured=True,
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(
            runtime=self._runtime_id,
            revision=2,
            schema={
                "type": "object",
                "properties": {
                    "environment": {"type": "object"},
                },
            },
            ui_schema={"environment": {"component": "keyValue"}},
            defaults={"environment": {}},
        )

    async def validate_config(self, values) -> RuntimeConfig:  # type: ignore[no-untyped-def]
        return RuntimeConfig(
            runtime=self._runtime_id,
            revision=1,
            values=dict(values),
            schema=(await self.get_config_schema()).schema,
            ui_schema=(await self.get_config_schema()).ui_schema,
            metadata={"validated": True},
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        _ = host
        self._runtime.config = config
        return self._runtime

    async def stop_runtime(self, runtime: AgentRuntime) -> None:
        await runtime.stop()




class FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def send(self, payload: str) -> None:
        self.messages.append(json.loads(payload))


class RecordingRuntimeHost(RuntimeHostClient):
    def __init__(self) -> None:
        self.events: list[tuple[str, str]] = []

    @property
    def connector_id(self) -> str:
        return "conn_1"

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
        self.events.append(("meta", session_id))

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
        self.events.append(("state", session_id))

    async def runtime_capabilities_update(
        self,
        capabilities: RuntimeCapabilitySet,
    ) -> None:
        self.events.append(("runtime_capabilities", capabilities.runtime))

    async def session_capabilities_update(
        self,
        capabilities: RuntimeCapabilitySet,
    ) -> None:
        self.events.append(("session_capabilities", capabilities.session_id or ""))

    async def timeline_sync(
        self,
        session_id: str,
        runtime: str,
        items: tuple[RuntimeTimelineItem, ...],
        external_session_id: str | None = None,
        complete: bool = True,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.events.append(("timeline", session_id))

    async def timeline_item_upsert(self, item: RuntimeTimelineItem) -> None:
        self.events.append(("timeline_item", item.session_id))

    async def notice_upsert(self, notice: SessionNotice) -> None:
        self.events.append(("notice", notice.session_id))

    async def runtime_error(
        self,
        runtime: str,
        code: str,
        message: str,
        session_id: str | None = None,
        external_session_id: str | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        self.events.append(("runtime_error", runtime))

    async def attachment_download(
        self,
        session_id: str,
        file_id: str,
    ) -> RuntimeAttachmentContent:
        raise NotImplementedError

    async def sync_state_read(self, key: str) -> Mapping[str, Any] | None:
        return None

    async def sync_state_write(self, key: str, value: Mapping[str, Any]) -> None:
        self.events.append(("sync_state_write", key))

    async def sync_state_delete(self, key: str) -> None:
        self.events.append(("sync_state_delete", key))


class FakeRuntimeSupervisor:
    def __init__(self, runtime: AgentRuntime) -> None:
        self._runtime = runtime
        self.runtimes = (runtime.identity.runtime,)

    def resolve_runtime(self, runtime_id: str) -> AgentRuntime:
        if runtime_id != self._runtime.identity.runtime:
            raise RuntimeError(f"unknown runtime {runtime_id}")
        return self._runtime


async def unused_notification_sender(method: str, params: dict[str, Any]) -> None:
    raise AssertionError(f"unexpected notification {method}: {params}")


def _client(
    runtime: FakeAgentRuntime | None = None,
    providers: tuple[RuntimeProvider, ...] | None = None,
    preferences_reader=None,  # type: ignore[no-untyped-def]
    **config_overrides: Any,
) -> BackendRpcClient:
    if providers is None:
        providers = (FakeAgentProvider(runtime or FakeAgentRuntime()),)
    return BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
            **config_overrides,
        ),
        agent_runtime_providers=providers,
        preferences_reader=preferences_reader,
    )


class FakeTerminalBackend(TerminalBackend):
    def _spawn(self, argv, *, cwd, env, rows, cols):
        return {"cwd": cwd}

    def _pid(self, pty) -> int | None:
        return 123

    def _terminate(self, pty) -> None:
        return None

    def _close(self, pty) -> None:
        return None

    def _read(self, pty) -> bytes:
        return b""

    def _wait_exit_code(self, pty) -> int | None:
        return 0

    def _setwinsize(self, pty, rows, cols) -> None:
        return None


class FakeSnapshotTerminalBackend(FakeTerminalBackend):
    def _spawn(self, argv, *, cwd, env, rows, cols):
        return {"cwd": cwd, "reads": [b"hello\n", b""]}

    def _read(self, pty) -> bytes:
        return pty["reads"].pop(0)


def test_connector_runtime_dispatches_request_and_forwards_notifications() -> None:
    asyncio.run(_exercise_runtime())


def test_connector_config_saves_and_loads_local_json(tmp_path) -> None:
    path = tmp_path / "connector.json"
    config = ConnectorConfig(
        server_url="http://127.0.0.1:8000",
        connector_id="conn_1",
        connector_token="cxt_secret",
        heartbeat_seconds=7,
        reconnect_seconds=1,
        sync_existing_on_connect=True,
        sync_interval_seconds=9,
    )

    saved_path = config.save(path)
    loaded = ConnectorConfig.load(saved_path)

    assert saved_path == path
    assert loaded == config
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_connector_coalesces_duplicate_timeline_upserts_within_batch() -> None:
    notifications = [
        {"method": "session.updated", "params": {"sessionId": "sess_1"}},
        {
            "method": "timeline.itemUpsert",
            "params": {"sessionId": "sess_1", "item": {"id": "item_1", "revision": 1}},
        },
        {
            "method": "timeline.itemUpsert",
            "params": {"sessionId": "sess_1", "item": {"id": "item_2", "revision": 1}},
        },
        {
            "method": "timeline.itemUpsert",
            "params": {"sessionId": "sess_1", "item": {"id": "item_1", "revision": 2}},
        },
        {"method": "notice.upsert", "params": {"sessionId": "sess_1"}},
    ]

    coalesced = coalesce_timeline_item_upserts(notifications)

    assert [item["method"] for item in coalesced] == [
        "session.updated",
        "timeline.itemUpsert",
        "timeline.itemUpsert",
        "notice.upsert",
    ]
    assert coalesced[1]["params"]["item"]["id"] == "item_2"
    assert coalesced[2]["params"]["item"] == {"id": "item_1", "revision": 2}


def test_connector_projects_inventory_capabilities_to_protocol_ids() -> None:
    payload = protocol_capabilities_from_inventory(
        {
            "runtimes": [
                {
                    "runtimeId": "codex",
                    "status": "available",
                    "configured": True,
                    "schema": {"type": "object"},
                    "capabilities": {
                        "modelCatalog": True,
                        "permissionCatalog": True,
                        "startTurn": True,
                        "steerTurn": True,
                        "interruptTurn": True,
                        "interactions": True,
                    },
                },
                {
                    "runtimeId": "claude",
                    "status": "available",
                    "configured": True,
                    "schema": {"type": "object"},
                    "capabilities": {
                        "modelCatalog": False,
                        "permissionCatalog": True,
                    },
                },
                {
                    "runtimeId": "unknown-agent",
                    "status": "available",
                    "configured": True,
                    "capabilities": {"modelCatalog": True},
                },
            ]
        }
    )

    by_runtime_and_id = {
        (item["runtime"], item["capabilityId"]): item
        for item in payload["capabilities"]
    }

    assert by_runtime_and_id[("codex", "catalog.model")]["available"] is True
    assert by_runtime_and_id[("codex", "catalog.permission")]["available"] is True
    assert by_runtime_and_id[("codex", "catalog.effort")]["available"] is True
    assert by_runtime_and_id[("codex", "session.send_message")]["available"] is True
    assert by_runtime_and_id[("codex", "session.steer")]["available"] is True
    assert by_runtime_and_id[("codex", "session.interrupt")]["available"] is True
    assert by_runtime_and_id[("codex", "session.interaction.approval")]["available"] is True
    assert by_runtime_and_id[("codex", "runtime.config")]["available"] is True
    assert by_runtime_and_id[("claude", "catalog.model")]["supported"] is False
    assert by_runtime_and_id[("claude", "catalog.model")]["available"] is False
    assert by_runtime_and_id[("claude", "catalog.permission")]["available"] is True
    assert ("unknown-agent", "catalog.model") not in by_runtime_and_id


def test_connector_runtime_host_live_notifications_use_websocket_when_connected() -> None:
    asyncio.run(_exercise_runtime_host_live_notification_uses_websocket())


async def _exercise_runtime_host_live_notification_uses_websocket() -> None:
    client = _client()
    ws = FakeWebSocket()
    client._rpc.set_connection(ws)  # type: ignore[arg-type]
    enqueued: list[tuple[str, dict[str, Any]]] = []

    async def enqueue(method: str, params: dict[str, Any]) -> None:
        enqueued.append((method, params))

    client._ingest.enqueue = enqueue  # type: ignore[method-assign]

    await client.agent_runtime_host.timeline_item_upsert(
        RuntimeTimelineItem(
            id="item_live",
            session_id="sess_1",
            type="message",
            status="running",
            order_seq=1,
            content_hash="sha256:live",
            role="assistant",
            content={"text": "live", "format": "markdown"},
            source={"runtime": "codex", "sessionId": "thread_1"},
        )
    )

    assert enqueued == []
    assert ws.messages == [
        {
            "type": "notification",
            "method": "timeline.itemUpsert",
            "params": {
                "sessionId": "sess_1",
                "item": {
                    "id": "item_live",
                    "sessionId": "sess_1",
                    "type": "message",
                    "status": "running",
                    "role": "assistant",
                    "content": {"text": "live", "format": "markdown"},
                    "source": {
                        "runtime": "codex",
                        "sessionId": "thread_1",
                        "itemId": "item_live",
                    },
                    "orderSeq": 1,
                    "revision": 1,
                    "contentHash": "sha256:live",
                },
            },
        }
    ]


def test_connector_runtime_host_notifications_fallback_to_ingest_without_websocket() -> None:
    asyncio.run(_exercise_runtime_host_notification_ingest_fallback())


def test_runtime_sync_pushes_each_session_snapshot_before_next_meta() -> None:
    asyncio.run(_exercise_runtime_sync_pushes_each_session_snapshot_before_next_meta())


async def _exercise_runtime_host_notification_ingest_fallback() -> None:
    client = _client()
    enqueued: list[tuple[str, dict[str, Any]]] = []

    async def enqueue(method: str, params: dict[str, Any]) -> None:
        enqueued.append((method, params))

    client._ingest.enqueue = enqueue  # type: ignore[method-assign]

    await client.send_backend_notification("session.meta.upsert", {"sessionId": "sess_1"})

    assert enqueued == [("session.meta.upsert", {"sessionId": "sess_1"})]


async def _exercise_runtime_sync_pushes_each_session_snapshot_before_next_meta() -> None:
    class SyncRuntime(FakeAgentRuntime):
        async def list_sessions(
            self,
            limit: int = 100,
            cursor: str | None = None,
            force: bool = False,
        ) -> tuple[SessionMeta, ...]:
            self.calls.append(
                (
                    "session.discover",
                    {"limit": limit, "cursor": cursor, "force": force},
                )
            )
            return (
                SessionMeta(
                    session_id="sess_changed",
                    external_session_id="thr_changed",
                    runtime=self.runtime_id,
                    title="Changed",
                    cwd="/repo",
                    ordering_time="2026-08-02T00:00:00Z",
                    metadata={"sync": {"requires_timeline_sync": True}},
                ),
                SessionMeta(
                    session_id="sess_unchanged",
                    external_session_id="thr_unchanged",
                    runtime=self.runtime_id,
                    title="Unchanged",
                    cwd="/repo",
                    ordering_time="2026-08-01T00:00:00Z",
                    metadata={"sync": {"requires_timeline_sync": False}},
                ),
            )

    runtime = SyncRuntime()
    host = RecordingRuntimeHost()
    runner = RuntimeSyncRunner(
        config=ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
        ),
        supervisor=FakeRuntimeSupervisor(runtime),  # type: ignore[arg-type]
        host=host,
        preferences_reader=dict,
        send_notification=unused_notification_sender,
    )

    await runner.sync_existing_once()

    assert host.events == [
        ("meta", "sess_changed"),
        ("timeline", "sess_changed"),
        ("state", "sess_changed"),
        ("notice", "sess_changed"),
        ("meta", "sess_unchanged"),
    ]
    assert [call[0] for call in runtime.calls] == [
        "session.discover",
        "session.sync",
        "session.state",
        "session.notices",
    ]


def test_connector_refreshes_expiring_access_token_before_ingest() -> None:
    asyncio.run(_exercise_access_token_refresh())


def test_connector_reauths_and_retries_ingest_on_401() -> None:
    asyncio.run(_exercise_ingest_reauth_on_401())


def test_connector_runtime_dispatches_local_fs_and_shell(tmp_path) -> None:
    asyncio.run(_exercise_local_ops(tmp_path))


def test_connector_terminal_create_falls_back_to_existing_parent(tmp_path) -> None:
    asyncio.run(_exercise_terminal_cwd_fallback(tmp_path))


def test_connector_terminal_resize_missing_terminal_is_idempotent() -> None:
    asyncio.run(_exercise_terminal_missing_resize())


def test_connector_terminal_release_keeps_snapshot_until_close(tmp_path) -> None:
    asyncio.run(_exercise_terminal_release_snapshot(tmp_path))


def test_connector_runtime_dispatches_async_shell_tasks(tmp_path) -> None:
    asyncio.run(_exercise_async_shell_tasks(tmp_path))


def test_connector_runtime_routes_by_runtime_param() -> None:
    asyncio.run(_exercise_runtime_protocol_routing())


def test_connector_runtime_uses_agent_runtime_for_turn_rpc(tmp_path) -> None:
    asyncio.run(_exercise_agent_runtime_turn_rpc(tmp_path))


def test_connector_runtime_discovers_agent_runtime_inventory() -> None:
    asyncio.run(_exercise_agent_runtime_discovery())


def test_default_runtime_providers_use_new_protocol_providers() -> None:
    providers = default_runtime_providers()

    assert tuple(provider.runtime for provider in providers) == ("codex", "claude")
    assert isinstance(providers[0], CodexProvider)
    assert isinstance(providers[1], ClaudeProvider)
    assert all(provider.__class__.__module__.startswith("connector.runtimes.") for provider in providers)


def test_connector_runtime_reads_config_schema() -> None:
    asyncio.run(_exercise_runtime_config_schema_read())


def test_connector_runtime_reads_only_effective_running_config() -> None:
    asyncio.run(_exercise_runtime_config_read())


def test_connector_runtime_disables_http_proxy_for_loopback_backend() -> None:
    from connector.server.urls import is_loopback_url

    assert is_loopback_url("http://127.0.0.1:8000") is True
    assert is_loopback_url("http://localhost:8000") is True
    assert is_loopback_url("http://[::1]:8000") is True
    assert is_loopback_url("https://agents.example.com") is False


def test_connector_runtime_maps_device_os(monkeypatch) -> None:
    from connector.server import urls

    monkeypatch.setattr(urls.sys, "platform", "darwin")
    assert urls.device_os() == "macos"
    monkeypatch.setattr(urls.sys, "platform", "win32")
    assert urls.device_os() == "windows"
    monkeypatch.setattr(urls.sys, "platform", "linux")
    assert urls.device_os() == "linux"


def test_connector_runtime_rejects_unknown_runtime() -> None:
    asyncio.run(_exercise_unknown_runtime())


def test_preferences_push_sends_only_on_change() -> None:
    asyncio.run(_exercise_preferences_push())



def test_connector_runtime_reconnects_quietly_on_websocket_close(monkeypatch) -> None:
    asyncio.run(_exercise_websocket_close_reconnect(monkeypatch))


def test_connector_runtime_stops_on_auth_websocket_close(monkeypatch) -> None:
    asyncio.run(_exercise_websocket_auth_close_stops(monkeypatch))


def test_connector_auth_401_is_terminal(monkeypatch) -> None:
    asyncio.run(_exercise_auth_401_is_terminal(monkeypatch))


async def _exercise_runtime() -> None:
    runtime = FakeAgentRuntime()
    client = _client(runtime)
    ws = FakeWebSocket()
    client._rpc.set_connection(ws)  # type: ignore[arg-type]
    notifications: list[dict[str, Any]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append({"method": method, "params": params})

    client.send_backend_notification = notify  # type: ignore[method-assign]
    client.agent_runtime_host._notifier = notify  # type: ignore[attr-defined]
    await client.dispatch("runtime.start", {"runtimeId": "codex", "config": {}})

    await client.handle_message(
        {
            "id": "rpc_1",
            "type": "request",
            "method": "session.create",
            "params": {
                "runtime": "codex",
                "sessionId": "sess_1",
                "cwd": "/repo",
                "content": "start",
                "selections": {"model": "sel_model"},
                "clientMessageId": "cm_1",
            },
        }
    )

    assert runtime.calls[-1] == (
        "session.create",
        {
            "sessionId": "sess_1",
            "content": "start",
            "title": None,
            "cwd": "/repo",
            "selections": {"model": "sel_model"},
            "attachments": (),
            "clientMessageId": "cm_1",
        },
    )
    assert ws.messages[0] == {
        "type": "notification",
        "method": "runtime.statusChanged",
        "params": {"runtimeId": "codex", "status": "validating"},
    }
    assert ws.messages[-1] == {
        "id": "rpc_1",
        "type": "response",
        "ok": True,
        "result": {
            "sessionId": "sess_1",
            "externalSessionId": "thr_created",
            "turnId": "turn_agent",
        },
    }

    await client.handle_message(
        {
            "id": "rpc_2",
            "type": "request",
            "method": "turn.start",
            "params": {"runtime": "codex", "sessionId": "sess_1", "externalSessionId": "thr_1", "content": "hi"},
        }
    )
    assert runtime.calls[-1][0] == "turn.start"
    assert ws.messages[-1]["result"] == {"turnId": "turn_agent"}

    await client.handle_message(
        {
            "id": "rpc_3",
            "type": "request",
            "method": "session.discover",
            "params": {"runtime": "codex", "limit": 5},
        }
    )
    assert runtime.calls[-1] == (
        "session.discover",
        {"limit": 5, "cursor": None, "force": True},
    )
    assert notifications[-1]["method"] == "session.meta.upsert"
    assert ws.messages[-1]["result"]["sessions"][0]["sessionId"] == "sess_existing"

    await client.handle_message(
        {
            "id": "rpc_4",
            "type": "request",
            "method": "session.sync",
            "params": {
                "runtime": "codex",
                "sessionId": "sess_1",
                "externalSessionId": "thr_1",
            },
        }
    )
    assert runtime.calls[-3][0] == "session.sync"
    assert runtime.calls[-2][0] == "session.state"
    assert runtime.calls[-1][0] == "session.notices"
    assert [item["method"] for item in notifications[-3:]] == [
        "timeline.sync",
        "session.state.updated",
        "notice.upsert",
    ]
    assert ws.messages[-1]["result"] == {
        "sessionId": "sess_1",
        "externalSessionId": "thr_1",
        "items": 1,
        "complete": True,
    }

    await client.handle_message(
        {
            "id": "rpc_5",
            "type": "request",
            "method": "session.state",
            "params": {
                "runtime": "codex",
                "sessionId": "sess_1",
                "externalSessionId": "thr_1",
            },
        }
    )
    assert runtime.calls[-1] == (
        "session.state",
        {"sessionId": "sess_1", "externalSessionId": "thr_1"},
    )
    assert ws.messages[-1]["result"]["state"]["selections"] == {"model": "sel_model_state"}

    await client.handle_message(
        {
            "id": "rpc_5a",
            "type": "request",
            "method": "session.notices",
            "params": {
                "runtime": "codex",
                "sessionId": "sess_1",
                "externalSessionId": "thr_1",
            },
        }
    )
    assert runtime.calls[-1] == (
        "session.notices",
        {"sessionId": "sess_1", "externalSessionId": "thr_1"},
    )
    assert ws.messages[-1]["result"]["notices"][0] == {
        "noticeId": "notice_1",
        "sessionId": "sess_1",
        "source": {"runtime": "codex"},
        "type": "interaction",
        "title": "Approval required",
        "severity": "info",
        "status": "open",
        "interactionType": "approval",
        "responseRequired": True,
        "actions": [{"actionId": "approve", "label": "Approve"}],
        "context": {},
        "metadata": {},
    }

    await client.handle_message(
        {
            "id": "rpc_5b",
            "type": "request",
            "method": "runtime.capabilities",
            "params": {"runtime": "codex"},
        }
    )
    assert runtime.calls[-1] == ("runtime.capabilities", {})
    assert ws.messages[-1]["result"]["capabilitySet"]["capabilities"][0] == {
        "capabilityId": "runtime.config",
        "version": "1",
        "scope": "runtime",
        "runtime": "codex",
        "supported": True,
        "available": True,
        "allowed": True,
        "metadata": {},
    }

    await client.handle_message(
        {
            "id": "rpc_5bb",
            "type": "request",
            "method": "runtime.commands",
            "params": {"runtime": "codex", "limit": 20},
        }
    )
    assert runtime.calls[-1] == ("runtime.commands", {"limit": 20})
    assert ws.messages[-1]["result"]["commands"][0] == {
        "id": "runtime-status",
        "title": "Runtime status",
        "description": None,
        "aliases": [],
        "category": None,
        "scope": "runtime",
        "enabled": True,
        "disabledReason": None,
        "acceptsArgs": False,
        "argsSchema": None,
        "metadata": {},
    }

    await client.handle_message(
        {
            "id": "rpc_5c",
            "type": "request",
            "method": "session.capabilities",
            "params": {
                "runtime": "codex",
                "sessionId": "sess_1",
                "externalSessionId": "thr_1",
            },
        }
    )
    assert runtime.calls[-1] == (
        "session.capabilities",
        {"sessionId": "sess_1", "externalSessionId": "thr_1"},
    )
    assert ws.messages[-1]["result"]["capabilitySet"]["capabilities"][0] == {
        "capabilityId": "session.interrupt",
        "version": "1",
        "scope": "session",
        "runtime": "codex",
        "sessionId": "sess_1",
        "supported": True,
        "available": False,
        "allowed": True,
        "unavailableReason": "session_not_running",
        "metadata": {},
    }

    await client.handle_message(
        {
            "id": "rpc_6",
            "type": "request",
            "method": "session.selections.update",
            "params": {
                "runtime": "codex",
                "sessionId": "sess_1",
                "externalSessionId": "thr_1",
                "selections": {"permission": "sel_permission"},
            },
        }
    )
    assert runtime.calls[-1] == (
        "session.selections.update",
        {
            "sessionId": "sess_1",
            "externalSessionId": "thr_1",
            "selections": {"permission": "sel_permission"},
        },
    )
    assert ws.messages[-1]["result"] == {"updated": True}

    await client.handle_message(
        {
            "id": "rpc_7",
            "type": "request",
            "method": "session.commands",
            "params": {
                "runtime": "codex",
                "sessionId": "sess_1",
                "externalSessionId": "thr_1",
                "query": "res",
                "limit": 10,
            },
        }
    )
    assert runtime.calls[-1] == (
        "session.commands",
        {
            "sessionId": "sess_1",
            "externalSessionId": "thr_1",
            "query": "res",
            "limit": 10,
        },
    )
    assert ws.messages[-1]["result"]["commands"] == [
        {
            "id": "resume",
            "title": "Resume",
            "description": "Resume the current turn.",
            "aliases": ["continue"],
            "category": "session",
            "scope": "session",
            "enabled": True,
            "disabledReason": None,
            "acceptsArgs": False,
            "argsSchema": None,
            "metadata": {},
        }
    ]

    await client.handle_message(
        {
            "id": "rpc_8",
            "type": "request",
            "method": "session.command.execute",
            "params": {
                "runtime": "codex",
                "sessionId": "sess_1",
                "externalSessionId": "thr_1",
                "command": "resume",
                "raw": "/resume",
                "args": ["now"],
            },
        }
    )
    assert runtime.calls[-1] == (
        "session.command.execute",
        {
            "sessionId": "sess_1",
            "externalSessionId": "thr_1",
            "command": "resume",
            "raw": "/resume",
            "args": ["now"],
        },
    )
    assert ws.messages[-1]["result"] == {
        "command": "resume",
        "ok": True,
        "code": None,
        "message": "Command executed.",
        "result": {"sessionId": "sess_1"},
    }

    await client.handle_message(
        {
            "id": "rpc_9",
            "type": "request",
            "method": "interaction.respond",
            "params": {
                "runtime": "codex",
                "sessionId": "sess_1",
                "noticeId": "notice_1",
                "actionId": "approve",
                "inputData": {"requestId": 42},
            },
        }
    )
    assert runtime.calls[-1] == (
        "interaction.respond",
        {
            "sessionId": "sess_1",
            "noticeId": "notice_1",
            "actionId": "approve",
            "inputData": {"requestId": 42},
        },
    )
    assert ws.messages[-1]["result"] == {"resolved": True, "noticeId": "notice_1"}

    await client.handle_message(
        {
            "id": "rpc_10",
            "type": "request",
            "method": "runtime.modelCatalog",
            "params": {"runtime": "codex", "query": "gpt", "limit": 20},
        }
    )
    assert runtime.calls[-1] == ("runtime.modelCatalog", {"query": "gpt", "limit": 20})
    assert ws.messages[-1]["result"]["catalog"]["models"][0]["displayName"] == "GPT Test"

    await client.handle_message(
        {
            "id": "rpc_11",
            "type": "request",
            "method": "runtime.permissionCatalog",
            "params": {"runtime": "codex", "query": "read", "limit": 20},
        }
    )
    assert runtime.calls[-1] == ("runtime.permissionCatalog", {"query": "read", "limit": 20})
    assert ws.messages[-1]["result"]["catalog"]["permissions"][0]["selectionId"] == "sel_permission_readonly"


async def _exercise_websocket_close_reconnect(monkeypatch) -> None:
    client = _client(reconnect_seconds=0)
    calls = 0
    sleeps: list[float] = []

    async def fake_run_once() -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            close = Close(1012, "service restart")
            raise ConnectionClosedError(close, close, None)
        raise asyncio.CancelledError

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(client, "run_once", fake_run_once)
    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    try:
        await client.run_forever()
    except asyncio.CancelledError:
        pass

    assert calls == 2
    assert sleeps == [0]


async def _exercise_websocket_auth_close_stops(monkeypatch) -> None:
    client = _client(reconnect_seconds=0)
    calls = 0

    async def fake_run_once() -> None:
        nonlocal calls
        calls += 1
        close = Close(4001, "connector token revoked")
        raise ConnectionClosedError(close, None, None)

    monkeypatch.setattr(client, "run_once", fake_run_once)

    try:
        await client.run_forever()
    except ConnectorAuthenticationError as exc:
        assert "credential" in str(exc)
    else:
        raise AssertionError("expected ConnectorAuthenticationError")

    assert calls == 1


async def _exercise_auth_401_is_terminal(monkeypatch) -> None:
    client = _client()

    class FakeResponse:
        status_code = 401

        def raise_for_status(self) -> None:
            raise AssertionError("raise_for_status should not be used for auth 401")

    class FakeHttpClient:
        async def post(self, *args: Any, **kwargs: Any) -> FakeResponse:
            return FakeResponse()

        async def aclose(self) -> None:
            return None

    client._auth._http_client_factory = lambda _timeout: FakeHttpClient()  # type: ignore[attr-defined]

    try:
        await client.authenticate()
    except ConnectorAuthenticationError as exc:
        assert "invalid connector credential" in str(exc)
    else:
        raise AssertionError("expected ConnectorAuthenticationError")


async def _exercise_access_token_refresh() -> None:
    client = _client()
    tokens = ["old", "new"]
    used_tokens: list[str] = []

    async def authenticate() -> str:
        token = tokens.pop(0)
        client._auth._access_token = token  # type: ignore[attr-defined]
        client._auth._access_token_expires_at = 0 if token == "old" else 10_000_000_000  # type: ignore[attr-defined]
        return token

    client._auth.authenticate = authenticate  # type: ignore[method-assign]

    await client.ensure_access_token(force=True)

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

    class FakeHttpClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __aenter__(self) -> Self:
            return self

        async def __aexit__(self, *args: object) -> None:
            return None

        async def aclose(self) -> None:
            return None

        async def post(self, *args: Any, **kwargs: Any) -> FakeResponse:
            used_tokens.append(str(kwargs["headers"]["Authorization"]))
            return FakeResponse()

    import connector.server.client as runtime_module

    original_client = runtime_module.httpx.AsyncClient
    runtime_module.httpx.AsyncClient = FakeHttpClient  # type: ignore[assignment]
    try:
        await client.ingest_notifications([{"method": "connector.heartbeat", "params": {}}])
    finally:
        runtime_module.httpx.AsyncClient = original_client

    assert used_tokens == ["Bearer new"]


async def _exercise_ingest_reauth_on_401() -> None:
    client = _client()
    tokens = ["expired", "fresh"]
    used_tokens: list[str] = []

    async def authenticate() -> str:
        token = tokens.pop(0)
        client._auth._access_token = token  # type: ignore[attr-defined]
        client._auth._access_token_expires_at = 10_000_000_000  # type: ignore[attr-defined]
        return token

    client._auth.authenticate = authenticate  # type: ignore[method-assign]

    class FakeResponse:
        def __init__(self, status_code: int) -> None:
            self.status_code = status_code

        def raise_for_status(self) -> None:
            if self.status_code >= 400:
                raise AssertionError(f"unexpected status {self.status_code}")

    class FakeHttpClient:
        async def aclose(self) -> None:
            return None

        async def post(self, *args: Any, **kwargs: Any) -> FakeResponse:
            used_tokens.append(str(kwargs["headers"]["Authorization"]))
            return FakeResponse(401 if len(used_tokens) == 1 else 200)

    client._http_client = FakeHttpClient()  # type: ignore[assignment]
    await client.ensure_access_token(force=True)

    await client.ingest_notifications([{"method": "terminal.output", "params": {}}])

    assert used_tokens == ["Bearer expired", "Bearer fresh"]


async def _exercise_local_ops(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "hello.txt").write_text("hello\n", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside\n", encoding="utf-8")

    client = _client()
    prepared = await client.dispatch(
        "fs.prepareDownload",
        {"root": str(workspace), "sessionId": "sess_1", "path": "hello.txt"},
    )
    assert prepared == {
        "path": str(workspace / "hello.txt"),
        "name": "hello.txt",
        "size": len(b"hello\n"),
        "sha256": hashlib.sha256(b"hello\n").hexdigest(),
        "mediaType": "text/plain",
    }

    write_result = await client.dispatch(
        "fs.writeFile",
        {"root": str(workspace), "path": "created.txt", "content": "created"},
    )
    assert write_result["bytesWritten"] == len("created")
    assert (workspace / "created.txt").read_text(encoding="utf-8") == "created"

    list_result = await client.dispatch("fs.readDir", {"root": str(workspace), "path": "."})
    assert [entry["name"] for entry in list_result["entries"]] == ["created.txt", "hello.txt"]

    fallback_list_result = await client.dispatch(
        "fs.readDir",
        {"root": str(workspace), "path": "missing/deleted"},
    )
    assert fallback_list_result["path"] == str(workspace)
    assert [entry["name"] for entry in fallback_list_result["entries"]] == ["created.txt", "hello.txt"]

    shell_result = await client.dispatch(
        "shell.exec",
        {
            "root": str(workspace),
            "cwd": str(workspace),
            "command": "pwd",
            "timeoutMs": 5000,
        },
    )
    assert shell_result["exitCode"] == 0
    assert shell_result["timedOut"] is False
    assert shell_result["stdout"].strip() == str(workspace)

    notifications: list[tuple[str, dict[str, Any]]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    client.local_ops.notify = notify
    task_start = await client.dispatch(
        "shell.task.start",
        {
            "taskId": "task_1",
            "sessionId": "sess_1",
            "root": str(workspace),
            "cwd": str(workspace),
            "command": "pwd",
            "timeoutMs": 5000,
        },
    )
    assert task_start == {"taskId": "task_1", "sessionId": "sess_1", "status": "running"}
    assert notifications[0] == ("shell.task.started", {"taskId": "task_1", "sessionId": "sess_1", "status": "running"})
    for _ in range(50):
        if len(notifications) >= 2:
            break
        await asyncio.sleep(0.01)
    assert notifications[-1][0] == "shell.task.completed"
    assert notifications[-1][1]["status"] == "completed"
    assert notifications[-1][1]["result"]["stdout"].strip() == str(workspace)

    outside_result = await client.dispatch(
        "fs.prepareDownload",
        {"root": str(workspace), "sessionId": "sess_1", "path": "../outside.txt"},
    )
    assert outside_result["path"] == str(outside)


async def _exercise_terminal_cwd_fallback(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    existing = workspace / "existing"
    existing.mkdir(parents=True)
    backend = FakeTerminalBackend()

    created = await backend.create(
        {
            "terminalId": "trm_1",
            "sessionId": "sess_1",
            "root": str(workspace),
            "cwd": str(existing / "deleted" / "leaf"),
            "cols": 100,
            "rows": 30,
        }
    )

    assert created["terminalId"] == "trm_1"
    assert created["cwd"] == str(existing)
    assert created["cols"] == 100
    assert created["rows"] == 30
    await backend.close({"terminalId": "trm_1"})


async def _exercise_terminal_missing_resize() -> None:
    backend = FakeTerminalBackend()

    result = await backend.resize(
        {
            "terminalId": "trm_missing",
            "sessionId": "sess_1",
            "cols": 100,
            "rows": 30,
        }
    )

    assert result == {"terminalId": "trm_missing", "closed": True}


async def _exercise_terminal_release_snapshot(tmp_path) -> None:
    backend = FakeSnapshotTerminalBackend()
    created = await backend.create(
        {
            "terminalId": "trm_snapshot",
            "sessionId": "sess_snapshot",
            "root": str(tmp_path),
        }
    )
    assert created["terminalId"] == "trm_snapshot"

    snapshot = {}
    for _ in range(20):
        await asyncio.sleep(0.05)
        snapshot = await backend.snapshot({"terminalId": "trm_snapshot"})
        if snapshot["dataBase64"]:
            break

    assert base64.b64decode(snapshot["dataBase64"]).strip() == b"hello"
    assert snapshot["outputs"] == [{"seq": 1, "dataBase64": base64.b64encode(b"hello\n").decode("ascii")}]
    released = await backend.release({"terminalId": "trm_snapshot"})
    assert released == {"terminalId": "trm_snapshot", "released": True}
    listing = await backend.list({"sessionId": "sess_snapshot"})
    assert [item["terminalId"] for item in listing["terminals"]] == ["trm_snapshot"]

    await backend.close({"terminalId": "trm_snapshot"})
    listing = await backend.list({"sessionId": "sess_snapshot"})
    assert listing["terminals"] == []


async def _exercise_runtime_protocol_routing() -> None:
    codex = FakeAgentRuntime("codex")
    claude = FakeAgentRuntime("claude")
    client = _client(
        providers=(
            FakeAgentProvider(codex, "codex"),
            FakeAgentProvider(claude, "claude"),
        )
    )
    client._rpc.set_connection(FakeWebSocket())  # type: ignore[arg-type]
    await client.dispatch("runtime.start", {"runtimeId": "codex", "config": {}})
    await client.dispatch("runtime.start", {"runtimeId": "claude", "config": {}})

    await client.dispatch("turn.start", {"runtime": "codex", "sessionId": "s1", "content": "hi"})
    await client.dispatch("turn.start", {"runtime": "claude", "sessionId": "s2", "content": "hi"})
    await client.dispatch(
        "turn.steer",
        {"runtime": "claude", "sessionId": "s2", "content": "focus"},
    )
    await client.dispatch("turn.interrupt", {"runtime": "claude", "sessionId": "s2", "reason": "user"})

    assert [c[0] for c in codex.calls] == ["turn.start"]
    assert [c[0] for c in claude.calls] == ["turn.start", "turn.steer", "turn.interrupt"]
    assert codex.calls[0][1]["sessionId"] == "s1"
    assert claude.calls[0][1]["sessionId"] == "s2"
    assert claude.calls[2][1]["reason"] == "user"


async def _exercise_agent_runtime_turn_rpc(tmp_path) -> None:
    agent_runtime = FakeAgentRuntime()
    client = _client(runtime=agent_runtime)
    client._rpc.set_connection(FakeWebSocket())  # type: ignore[arg-type]
    await client.dispatch("runtime.start", {"runtimeId": "codex", "config": {}})

    started = await client.dispatch(
        "turn.start",
        {
            "runtime": "codex",
            "sessionId": "sess_1",
            "externalSessionId": "thr_1",
            "content": "hi",
            "clientMessageId": "cm_1",
            "attachments": [{"fileId": "file_1", "name": "a.txt"}],
        },
    )
    steered = await client.dispatch(
        "turn.steer",
        {
            "runtime": "codex",
            "sessionId": "sess_1",
            "externalSessionId": "thr_1",
            "content": "focus",
            "clientMessageId": "cm_2",
        },
    )
    interrupted = await client.dispatch(
        "turn.interrupt",
        {
            "runtime": "codex",
            "sessionId": "sess_1",
            "externalSessionId": "thr_1",
            "reason": "user",
        },
    )

    assert agent_runtime.started is True
    assert started == {"turnId": "turn_agent"}
    assert steered == {"steered": True, "turnId": "turn_agent"}
    assert interrupted == {"interrupted": True, "turnId": "turn_agent"}
    assert [call[0] for call in agent_runtime.calls] == [
        "turn.start",
        "turn.steer",
        "turn.interrupt",
    ]
    assert agent_runtime.calls[0][1]["attachments"][0].file_id == "file_1"
    assert agent_runtime.calls[0][1]["clientMessageId"] == "cm_1"


async def _exercise_agent_runtime_discovery() -> None:
    agent_runtime = FakeAgentRuntime()
    client = _client(runtime=agent_runtime)
    client._rpc.set_connection(FakeWebSocket())  # type: ignore[arg-type]

    inventory = await client.dispatch("runtime.discover", {})

    assert inventory["runtimes"] == [
        {
            "runtimeId": "codex",
            "runtimeType": "codex",
            "displayName": "Codex",
            "discovery": {"available": True},
            "schema": None,
            "uiSchema": None,
            "defaults": {},
            "status": "available",
            "configured": True,
            "capabilities": {},
            "metadata": {},
        }
    ]


async def _exercise_runtime_config_schema_read() -> None:
    client = _client(runtime=FakeAgentRuntime("codex"))

    result = await client.dispatch("runtime.configSchema", {"runtimeId": "codex"})

    assert result["configSchema"] == {
        "runtime": "codex",
        "revision": 2,
        "schema": {
            "type": "object",
            "properties": {
                "environment": {"type": "object"},
            },
        },
        "uiSchema": {"environment": {"component": "keyValue"}},
        "defaults": {"environment": {}},
        "metadata": {},
    }


async def _exercise_runtime_config_read() -> None:
    runtime = FakeAgentRuntime("codex")
    client = _client(runtime=runtime)
    client._rpc.set_connection(FakeWebSocket())  # type: ignore[arg-type]

    stopped = await client.dispatch("runtime.config", {"runtimeId": "codex"})
    await client.dispatch(
        "runtime.start",
        {
            "runtimeId": "codex",
            "config": {"environment": {"EXAMPLE": "1"}},
        },
    )
    running = await client.dispatch("runtime.config", {"runtimeId": "codex"})

    assert stopped == {
        "runtimeId": "codex",
        "running": False,
        "config": None,
    }
    assert running == {
        "runtimeId": "codex",
        "running": True,
        "config": {
            "runtime": "codex",
            "revision": 1,
            "values": {"environment": {"EXAMPLE": "1"}},
            "schema": {
                "type": "object",
                "properties": {
                    "environment": {"type": "object"},
                },
            },
            "uiSchema": {"environment": {"component": "keyValue"}},
            "metadata": {"validated": True},
        },
    }


async def _exercise_unknown_runtime() -> None:
    client = _client()
    try:
        await client.dispatch("turn.start", {"runtime": "opencode", "sessionId": "s1", "content": "hi"})
    except RuntimeError as exc:
        assert "opencode" in str(exc)
    else:
        raise AssertionError("expected RuntimeError for unknown runtime")


async def _exercise_preferences_push() -> None:
    snapshots = [
        {"permissionMode": "default", "model": None, "effort": None, "readAt": "t0"},
        {"permissionMode": "default", "model": None, "effort": None, "readAt": "t1"},  # readAt churn, no real change
        {"permissionMode": "bypassPermissions", "model": None, "effort": None, "readAt": "t2"},
    ]
    cursor = iter(snapshots)

    def reader() -> dict[str, Any]:
        return next(cursor)

    client = _client(preferences_reader=reader)
    pushed: list[tuple[str, dict[str, Any]]] = []

    async def fake_notify(method: str, params: dict[str, Any]) -> None:
        pushed.append((method, params))

    client._runtime_sync.send_notification = fake_notify

    await client._runtime_sync.push_preferences_if_changed()  # t0 — first read, push
    await client._runtime_sync.push_preferences_if_changed()  # t1 — only readAt changed, no push
    await client._runtime_sync.push_preferences_if_changed()  # t2 — mode changed, push

    assert [p[0] for p in pushed] == [
        "connector.preferencesUpdated",
        "connector.preferencesUpdated",
    ]
    assert pushed[0][1]["permissionMode"] == "default"
    assert pushed[1][1]["permissionMode"] == "bypassPermissions"



async def _exercise_async_shell_tasks(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    client = _client()
    notifications: list[tuple[str, dict[str, Any]]] = []

    async def notify(method: str, params: dict[str, Any]) -> None:
        notifications.append((method, params))

    client.local_ops.notify = notify
    await client.dispatch(
        "shell.task.start",
        {
            "taskId": "task_cancel",
            "sessionId": "sess_1",
            "root": str(workspace),
            "cwd": str(workspace),
            "command": f"{sys.executable} -c \"import time; time.sleep(10)\"",
            "timeoutMs": 300000,
        },
    )
    cancel_result = await client.dispatch("shell.task.cancel", {"taskId": "task_cancel", "sessionId": "sess_1"})

    assert cancel_result == {"taskId": "task_cancel", "sessionId": "sess_1", "cancelled": True}
    assert notifications[-1] == ("shell.task.completed", {"taskId": "task_cancel", "sessionId": "sess_1", "status": "cancelled"})
