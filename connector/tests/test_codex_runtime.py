from __future__ import annotations

import asyncio
import threading
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any

from openai_codex.generated.v2_all import (
    AgentMessageThreadItem,
    ContextCompactedNotification,
    ContextCompactionThreadItem,
    TextUserInput,
    ThreadItem,
    Turn,
    TurnStatus,
    UserInput,
    UserMessageThreadItem,
)
from openai_codex.models import (
    AgentMessageDeltaNotification,
    CommandExecutionOutputDeltaNotification,
    Notification,
    TurnCompletedNotification,
)

from connector.runtime_protocol import (
    CAPABILITY_CATALOG_MODEL,
    CAPABILITY_RUNTIME_CONFIG,
    CAPABILITY_SESSION_COMMANDS,
    CAPABILITY_SESSION_INTERRUPT,
    CAPABILITY_SESSION_SEND_MESSAGE,
    CAPABILITY_SESSION_STEER,
    CommandToolContent,
    CompactSystemContent,
    MarkdownMessageContent,
    MessageTimelineContent,
    RuntimeCapabilitySet,
    RuntimeConfig,
    RuntimeInvalidRequestError,
    SessionNotice,
    TimelineSource,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain.catalogs import (
    model_catalog_from_codex_items,
    permission_catalog_from_codex_items,
)
from connector.runtimes.codex.domain.sessions import stable_session_id
from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sdk.client import CodexSdkClient
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.sdk.runtime_client import (
    CodexCompactResult,
    CodexInterruptTurnRequest,
    CodexModelListResult,
    CodexStartThreadRequest,
    CodexStartTurnRequest,
    CodexSteerTurnRequest,
    CodexThreadListResult,
    CodexThreadReadResult,
    CodexThreadResult,
    CodexTurnResult,
)
from connector.runtimes.codex.sdk.shapes import notification_dict, thread_ref
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator
from connector.runtimes.codex.timeline.items import (
    CodexAgentMessageItem,
    CodexCommandExecutionItem,
    CodexContextCompactionItem,
    CodexFileChangeItem,
    CodexReasoningItem,
    CodexRuntimeMessageItem,
    CodexTimelineItem,
    CodexTurnEndItem,
    CodexTurnStartItem,
    CodexUnknownItem,
    CodexUserMessageItem,
    codex_timeline_item_class,
)
from connector.runtimes.codex.timeline.projection import (
    CodexTimelineProjection,
    timeline_item_from_projection,
)
from connector.runtimes.codex.timeline.typed_events import (
    timeline_projections_from_sdk_turn_event,
)


def test_codex_timeline_item_maps_native_type_to_platform_parent_type() -> None:
    codex_item = CodexTimelineItem(
        id="item_agent",
        type="message",
        status="done",
        role="assistant",
        turn_id="turn_1",
        content=MessageTimelineContent(text="hello"),
        source=TimelineSource(runtime="codex"),
        native_item_type="agentMessage",
        native_item_id="native_agent",
        external_session_id="thread_1",
        event="thread/read",
        derived_key="agentMessage-native_agent",
        client_message_id="cm_1",
    )

    platform_item = codex_item.to_platform_item(session_id="sess_1", order_seq=3)

    assert platform_item.type == "message"
    assert platform_item.content == {
        "kind": "markdown",
        "text": "hello",
        "format": "markdown",
    }
    assert platform_item.source == {
        "runtime": "codex",
        "event": "thread/read",
        "threadId": "thread_1",
        "rawType": "agentMessage",
        "itemId": "native_agent",
        "derivedKey": "agentMessage-native_agent",
        "clientMessageId": "cm_1",
    }


def test_codex_timeline_native_item_classes_are_explicitly_mapped() -> None:
    assert codex_timeline_item_class("agentMessage") is CodexAgentMessageItem
    assert codex_timeline_item_class("userMessage") is CodexUserMessageItem
    assert codex_timeline_item_class("reasoning") is CodexReasoningItem
    assert codex_timeline_item_class("runtimeMessage") is CodexRuntimeMessageItem
    assert codex_timeline_item_class("commandExecution") is CodexCommandExecutionItem
    assert (
        codex_timeline_item_class("contextCompaction")
        is CodexContextCompactionItem
    )
    assert codex_timeline_item_class("fileChange") is CodexFileChangeItem
    assert codex_timeline_item_class("turnStart") is CodexTurnStartItem
    assert codex_timeline_item_class("turnEnd") is CodexTurnEndItem
    assert codex_timeline_item_class("futureNativeType") is CodexUnknownItem


def test_codex_projection_maps_message_content_to_specific_platform_content() -> None:
    projection = CodexTimelineProjection(
        native_id="item_agent",
        raw_type="agentMessage",
        role="assistant",
        text="hello",
    )

    item = timeline_item_from_projection(
        projection=projection,
        external_session_id="thread_1",
        fallback_index=0,
        event="thread/read",
    )

    assert isinstance(item.content, MarkdownMessageContent)
    assert item.to_platform_item(session_id="sess_1", order_seq=0).content == {
        "kind": "markdown",
        "text": "hello",
        "format": "markdown",
    }


def test_codex_projection_maps_command_content_to_specific_platform_content() -> None:
    projection = CodexTimelineProjection(
        native_id="item_command",
        raw_type="commandExecution",
        command="pytest",
        aggregated_output="ok",
        exit_code=0,
    )

    item = timeline_item_from_projection(
        projection=projection,
        external_session_id="thread_1",
        fallback_index=0,
        event="thread/read",
    )

    assert isinstance(item.content, CommandToolContent)
    assert item.to_platform_item(session_id="sess_1", order_seq=0).content == {
        "kind": "command",
        "command": "pytest",
        "output": "ok",
        "format": "text",
    }


def test_codex_projection_maps_context_compaction_to_compact_content() -> None:
    projection = CodexTimelineProjection(
        native_id="compact_1",
        raw_type="contextCompaction",
        status="completed",
        role="system",
        turn_id="turn_1",
        message="The session context was compacted.",
    )

    item = timeline_item_from_projection(
        projection=projection,
        external_session_id="thread_1",
        fallback_index=0,
        event="thread/read",
    )
    platform_item = item.to_platform_item(session_id="sess_1", order_seq=0)

    assert isinstance(item, CodexContextCompactionItem)
    assert isinstance(item.content, CompactSystemContent)
    assert platform_item.type == "system"
    assert platform_item.role == "system"
    assert platform_item.content == {
        "kind": "compact",
        "text": "The session context was compacted.",
        "format": "markdown",
        "state": "completed",
    }
    assert platform_item.source["rawType"] == "contextCompaction"


class FakeCodexClient:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.responses: list[tuple[str | int, dict[str, Any]]] = []
        self.response_error: Exception | None = None
        self.handler: Any | None = None
        self.results: dict[str, dict[str, Any]] = {
            "model/list": {
                "models": [
                    {
                        "id": "gpt-example",
                        "displayName": "GPT Example",
                        "description": "SDK model description",
                        "supportedReasoningEfforts": [
                            {"id": "low", "description": "SDK low reasoning description"},
                            {"id": "high", "description": "SDK high reasoning description"},
                        ],
                    },
                    {
                        "id": "gpt-plain",
                        "displayName": "GPT Plain",
                    },
                ]
            },
            "thread/loaded/list": {},
            "thread/list": {
                "threads": [
                    {
                        "id": "thread_1",
                        "name": "Fix tests",
                        "cwd": "/repo",
                        "updatedAt": "2026-08-02T00:00:00Z",
                    },
                    {
                        "id": "thread_archived",
                        "name": "Archived",
                        "archived": True,
                    },
                ]
            },
            "thread/read": {
                "thread": {
                    "id": "thread_1",
                    "items": [
                        {
                            "id": "item_user",
                            "type": "userMessage",
                            "status": "done",
                            "input": [
                                {"type": "text", "text": "hello"},
                            ],
                            "turnId": "turn_1",
                        },
                        {
                            "id": "item_assistant",
                            "type": "message",
                            "role": "assistant",
                            "text": "hi",
                            "status": "done",
                        },
                    ],
                }
            },
            "thread/start": {
                "thread": {
                    "id": "thread_new",
                    "name": "New thread",
                }
            },
            "turn/start": {
                "turn": {
                    "id": "turn_new",
                }
            },
            "turn/steer": {
                "turn": {
                    "id": "turn_new",
                }
            },
            "turn/interrupt": {
                "turn": {
                    "id": "turn_new",
                }
            },
            "thread/compact/start": {},
        }

    async def start(self, handler) -> None:  # type: ignore[no-untyped-def]
        self.handler = handler
        self.started = True

    async def stop(self) -> None:
        self.stopped = True

    def record_request(self, method: str, params: Mapping[str, Any]) -> dict[str, Any]:
        self.requests.append((method, dict(params)))
        result = self.results.get(method, {})
        if isinstance(result, Exception):
            raise result
        return result

    async def list_models(self) -> CodexModelListResult:
        result = self.record_request("model/list", {})
        models = result["models"]
        return CodexModelListResult(models=tuple(models))

    async def list_threads(
        self,
        limit: int = 100,
        cursor: str | None = None,
    ) -> CodexThreadListResult:
        params: dict[str, Any] = {
            "limit": limit,
            "sortKey": "updated_at",
        }
        if cursor is not None:
            params["cursor"] = cursor
        result = self.record_request("thread/list", params)
        threads = result["threads"]
        return CodexThreadListResult(threads=tuple(threads))

    async def read_thread(
        self,
        thread_id: str,
        include_turns: bool = True,
    ) -> CodexThreadReadResult:
        result = self.record_request(
            "thread/read",
            {
                "threadId": thread_id,
                "includeTurns": include_turns,
            },
        )
        thread = result["thread"]
        return CodexThreadReadResult(thread=thread)

    async def start_thread(self, request: CodexStartThreadRequest) -> CodexThreadResult:
        result = self.record_request(
            "thread/start",
            {
                "cwd": request.cwd,
                "model": request.model,
                "approvalPolicy": request.approval_policy,
                "sandbox": request.sandbox,
                "ephemeral": request.ephemeral,
            },
        )
        thread = result["thread"]
        return CodexThreadResult(thread_id=thread["id"], payload=thread)

    async def start_turn(self, request: CodexStartTurnRequest) -> CodexTurnResult:
        params: dict[str, Any] = {
            "threadId": request.thread_id,
            "input": [{"type": "text", "text": request.content, "text_elements": []}],
            "clientUserMessageId": request.client_message_id,
            "model": request.model,
            "effort": request.effort,
            "approvalPolicy": request.approval_policy,
            "sandbox": request.sandbox,
        }
        result = self.record_request(
            "turn/start",
            {key: value for key, value in params.items() if value is not None},
        )
        turn = result["turn"]
        return CodexTurnResult(turn_id=turn["id"], payload=turn)

    async def steer_turn(self, request: CodexSteerTurnRequest) -> CodexTurnResult:
        result = self.record_request(
            "turn/steer",
            {
                "threadId": request.thread_id,
                "input": [{"type": "text", "text": request.content, "text_elements": []}],
                "expectedTurnId": request.turn_id,
                "clientUserMessageId": request.client_message_id,
            },
        )
        turn = result["turn"]
        return CodexTurnResult(turn_id=turn["id"], payload=turn)

    async def interrupt_turn(
        self,
        request: CodexInterruptTurnRequest,
    ) -> CodexTurnResult:
        result = self.record_request(
            "turn/interrupt",
            {
                "threadId": request.thread_id,
                "turnId": request.turn_id,
            },
        )
        turn = result["turn"]
        return CodexTurnResult(turn_id=turn["id"], payload=turn)

    async def compact_thread(self, thread_id: str) -> CodexCompactResult:
        result = self.record_request("thread/compact/start", {"threadId": thread_id})
        return CodexCompactResult(payload=result)

    async def respond(
        self,
        request_id: str | int,
        result: Mapping[str, Any] | None = None,
    ) -> None:
        if self.response_error is not None:
            raise self.response_error
        self.responses.append((request_id, dict(result or {})))


class FakeHost(RuntimeHostClient):
    def __init__(self) -> None:
        self.meta_upserts: list[dict[str, Any]] = []
        self.state_updates: list[dict[str, Any]] = []
        self.timeline_syncs: list[dict[str, Any]] = []
        self.timeline_item_upserts: list[Any] = []
        self.notice_upserts: list[SessionNotice] = []
        self.runtime_capability_updates: list[RuntimeCapabilitySet] = []
        self.session_capability_updates: list[RuntimeCapabilitySet] = []
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

    async def timeline_sync(
        self,
        session_id: str,
        runtime: str,
        items: tuple[Any, ...],
        external_session_id: str | None = None,
        complete: bool = True,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.timeline_syncs.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "external_session_id": external_session_id,
                "items": items,
                "complete": complete,
                "metadata": dict(metadata or {}),
            }
        )

    async def timeline_item_upsert(self, item: Any) -> None:
        self.timeline_item_upserts.append(item)

    async def notice_upsert(self, notice: SessionNotice) -> None:
        self.notice_upserts.append(notice)

    async def runtime_capabilities_update(
        self,
        capabilities: RuntimeCapabilitySet,
    ) -> None:
        self.runtime_capability_updates.append(capabilities)

    async def session_capabilities_update(
        self,
        capabilities: RuntimeCapabilitySet,
    ) -> None:
        self.session_capability_updates.append(capabilities)

    async def sync_state_read(self, key: str) -> Mapping[str, Any] | None:
        return self.sync_states.get(key)

    async def sync_state_write(
        self,
        key: str,
        value: Mapping[str, Any],
    ) -> None:
        self.sync_states[key] = dict(value)

    async def sync_state_delete(self, key: str) -> None:
        self.sync_states.pop(key, None)


def test_codex_runtime_lifecycle_and_config() -> None:
    asyncio.run(_test_codex_runtime_lifecycle_and_config())


async def _test_codex_runtime_lifecycle_and_config() -> None:
    client = FakeCodexClient()
    config = _config()
    runtime = CodexRuntime(config=config, host=FakeHost(), client=client)

    assert runtime.identity.runtime == "codex"
    assert await runtime.get_config() == config

    await runtime.start()
    await runtime.stop()

    assert client.started is True
    assert client.stopped is True


def test_codex_sdk_event_normalizes_legacy_method_dict() -> None:
    event = CodexSdkEvent.from_value(
        {
            "jsonrpc": "2.0",
            "id": 42,
            "method": "item/started",
            "params": {
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "id": "item_1",
                    "type": "agentMessage",
                    "role": "assistant",
                    "status": "inProgress",
                    "text": "hello",
                },
            },
        }
    )

    assert event.legacy_method_shaped is True
    assert event.event_type == "item/started"
    assert event.thread_id == "thread_1"
    assert event.turn_id == "turn_1"
    assert event.item_id == "item_1"
    assert event.item_type == "agentMessage"
    assert event.role == "assistant"
    assert event.status == "inProgress"
    assert event.content == "hello"
    assert event.request_id == 42


def test_codex_sdk_event_normalizes_typed_sdk_notification() -> None:
    event = CodexSdkEvent.from_value(
        Notification(
            method="item/agentMessage/delta",
            payload=AgentMessageDeltaNotification(
                delta="hel",
                itemId="item_agent",
                threadId="thread_1",
                turnId="turn_1",
            ),
        ),
    )

    assert event.legacy_method_shaped is False
    assert event.event_type == "item/agentMessage/delta"
    assert event.thread_id == "thread_1"
    assert event.turn_id == "turn_1"
    assert event.item_id == "item_agent"
    assert event.item_type == "agentMessage"
    assert event.role == "assistant"
    assert event.status == "inProgress"
    assert event.content == "hel"


def test_codex_sdk_event_normalizes_typed_turn_completion() -> None:
    event = CodexSdkEvent.from_value(
        Notification(
            method="turn/completed",
            payload=TurnCompletedNotification(
                threadId="thread_1",
                turn=Turn(
                    id="turn_done",
                    status=TurnStatus.completed,
                    items=[
                        ThreadItem(
                            root=AgentMessageThreadItem(
                                id="item_agent",
                                type="agentMessage",
                                text="hello",
                                memoryCitation=None,
                                phase=None,
                            )
                        )
                    ],
                    completedAt=None,
                    durationMs=None,
                    error=None,
                    itemsView=None,
                    startedAt=None,
                ),
            ),
        ),
    )

    assert event.event_type == "turn/completed"
    assert event.thread_id == "thread_1"
    assert event.params["turn"]["id"] == "turn_done"
    assert event.params["turn"]["items"][0]["type"] == "agentMessage"
    assert event.params["turn"]["items"][0]["text"] == "hello"


def test_codex_timeline_projects_context_compaction_thread_item() -> None:
    event = CodexSdkEvent.from_value(
        Notification(
            method="turn/completed",
            payload=TurnCompletedNotification(
                threadId="thread_1",
                turn=Turn(
                    id="turn_done",
                    status=TurnStatus.completed,
                    items=[
                        ThreadItem(
                            root=ContextCompactionThreadItem(
                                id="compact_1",
                                type="contextCompaction",
                            )
                        )
                    ],
                    completedAt=None,
                    durationMs=None,
                    error=None,
                    itemsView=None,
                    startedAt=None,
                ),
            ),
        ),
    )

    projections = timeline_projections_from_sdk_turn_event(event)

    assert projections is not None
    assert len(projections) == 1
    assert projections[0].raw_type == "contextCompaction"
    item = timeline_item_from_projection(
        projection=projections[0],
        external_session_id="thread_1",
        fallback_index=0,
        event="turn/completed",
    )
    platform_item = item.to_platform_item(session_id="sess_1", order_seq=0)
    assert isinstance(item, CodexContextCompactionItem)
    assert platform_item.content["kind"] == "compact"
    assert platform_item.source["rawType"] == "contextCompaction"


def test_codex_runtime_thread_compacted_notification_upserts_timeline_item() -> None:
    asyncio.run(_test_codex_runtime_thread_compacted_notification_upserts_timeline_item())


async def _test_codex_runtime_thread_compacted_notification_upserts_timeline_item() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime._handle_notification(
        Notification(
            method="thread/compacted",
            payload=ContextCompactedNotification(
                threadId="thread_1",
                turnId="turn_compact",
            ),
        )
    )

    assert len(host.timeline_item_upserts) == 1
    item = host.timeline_item_upserts[0]
    assert item.type == "system"
    assert item.status == "done"
    assert item.turn_id == "turn_compact"
    assert item.content["kind"] == "compact"
    assert item.content["state"] == "completed"
    assert item.source["rawType"] == "contextCompaction"
    assert host.state_updates[-1]["status"] == "idle"
    assert host.state_updates[-1]["metadata"]["source"] == "codex.thread/compacted"


def test_codex_compaction_snapshot_reuses_started_timeline_item() -> None:
    accumulator = CodexTimelineAccumulator()
    started = accumulator.item_from_notification(
        session_id="sess_1",
        external_session_id="thread_1",
        method="thread/compact/started",
        params={"threadId": "thread_1"},
    )
    assert started is not None

    snapshot_items = accumulator.items_from_thread_snapshot(
        session_id="sess_1",
        external_session_id="thread_1",
        thread={
            "items": [
                {
                    "id": "compact_1",
                    "type": "contextCompaction",
                    "status": "completed",
                }
            ]
        },
        limit=100,
    )

    assert len(snapshot_items) == 1
    assert snapshot_items[0].id == started.id
    assert snapshot_items[0].content["kind"] == "compact"
    assert snapshot_items[0].content["state"] == "completed"


def test_codex_compaction_snapshot_skips_transcript_message_mirrors() -> None:
    accumulator = CodexTimelineAccumulator()

    snapshot_items = accumulator.items_from_thread_snapshot(
        session_id="sess_1",
        external_session_id="thread_1",
        thread={
            "items": [
                {
                    "id": "context_compaction_thread_1",
                    "type": "contextCompaction",
                    "status": "completed",
                },
                {
                    "id": "item-2",
                    "type": "agentMessage",
                    "status": "completed",
                    "text": "old assistant answer",
                },
                {
                    "id": "item-3",
                    "type": "userMessage",
                    "status": "completed",
                    "text": "old user message",
                },
                {
                    "id": "file_1",
                    "type": "fileChange",
                    "status": "completed",
                    "changes": [
                        {
                            "path": "app.py",
                            "diff": "+print('hi')",
                            "kind": {"type": "modify"},
                        }
                    ],
                },
                {
                    "id": "msg_new",
                    "type": "agentMessage",
                    "status": "completed",
                    "turnId": "turn_after_compact",
                    "text": "new answer",
                },
            ]
        },
        limit=100,
    )

    assert [item.id for item in snapshot_items] == [
        "context_compaction_thread_1",
        "file_1",
        "msg_new",
    ]


def test_codex_timeline_projects_typed_sdk_delta_without_params_dict() -> None:
    event = CodexSdkEvent.from_value(
        Notification(
            method="item/commandExecution/outputDelta",
            payload=CommandExecutionOutputDeltaNotification(
                delta="running tests",
                itemId="item_command",
                threadId="thread_1",
                turnId="turn_1",
            ),
        ),
    )
    event_without_params = replace(event, params={})
    accumulator = CodexTimelineAccumulator()

    item = accumulator.item_from_event(
        session_id="sess_1",
        external_session_id="thread_1",
        event=event_without_params,
    )

    assert item is not None
    assert item.id == "item_command"
    assert item.type == "tool"
    assert item.status == "running"
    assert item.content == {
        "kind": "command",
        "command": "",
        "output": "running tests",
        "format": "text",
    }


def test_codex_timeline_projects_typed_sdk_turn_without_params_dict() -> None:
    event = CodexSdkEvent.from_value(
        Notification(
            method="turn/completed",
            payload=TurnCompletedNotification(
                threadId="thread_1",
                turn=Turn(
                    id="turn_done",
                    status=TurnStatus.completed,
                    items=[
                        ThreadItem(
                            root=AgentMessageThreadItem(
                                id="item_agent",
                                type="agentMessage",
                                text="hello",
                                memoryCitation=None,
                                phase=None,
                            )
                        )
                    ],
                    completedAt=None,
                    durationMs=None,
                    error=None,
                    itemsView=None,
                    startedAt=None,
                ),
            ),
        ),
    )
    event_without_params = replace(event, params={})
    accumulator = CodexTimelineAccumulator()

    items = accumulator.items_from_turn_event(
        session_id="sess_1",
        external_session_id="thread_1",
        event=event_without_params,
    )

    assert len(items) == 2
    message_item = items[0]
    turn_end = items[1]
    assert message_item.id == "item_agent"
    assert message_item.type == "message"
    assert message_item.content == {
        "kind": "markdown",
        "text": "hello",
        "format": "markdown",
    }
    assert turn_end.id == "codex_turn_end_turn_done"
    assert turn_end.turn_id == "turn_done"
    assert turn_end.type == "turn.end"
    assert turn_end.status == "done"


def test_codex_timeline_uses_typed_sdk_user_client_id_for_identity() -> None:
    event = CodexSdkEvent.from_value(
        Notification(
            method="turn/completed",
            payload=TurnCompletedNotification(
                threadId="thread_1",
                turn=Turn(
                    id="turn_done",
                    status=TurnStatus.completed,
                    items=[
                        ThreadItem(
                            root=UserMessageThreadItem(
                                id="item_user",
                                type="userMessage",
                                clientId="msg_client_1",
                                content=[
                                    UserInput(
                                        root=TextUserInput(
                                            type="text",
                                            text="hello from web",
                                        )
                                    )
                                ],
                            )
                        )
                    ],
                    completedAt=None,
                    durationMs=None,
                    error=None,
                    itemsView=None,
                    startedAt=None,
                ),
            ),
        ),
    )
    accumulator = CodexTimelineAccumulator()

    items = accumulator.items_from_turn_event(
        session_id="sess_1",
        external_session_id="thread_1",
        event=event,
    )

    assert items[0].id == "codex_client_msg_client_1"
    assert items[0].source["itemId"] == "item_user"
    assert items[0].source["clientMessageId"] == "msg_client_1"


def test_codex_sdk_event_normalizes_explicit_dict_shape() -> None:
    event = CodexSdkEvent.from_value(
        {
            "type": "item/completed",
            "item": {
                "id": "item_user",
                "type": "userMessage",
                "role": "user",
                "status": "completed",
                "content": {"text": "hi"},
            },
        },
        thread_id="thread_1",
    )

    assert event.event_type == "item/completed"
    assert event.thread_id == "thread_1"
    assert event.item_id == "item_user"
    assert event.item_type == "userMessage"
    assert event.role == "user"
    assert event.status == "completed"
    assert event.content == {"text": "hi"}


def test_codex_sdk_notification_dict_uses_normalized_event_shape() -> None:
    message = notification_dict(
        {
            "type": "item/commandExecution/outputDelta",
            "item": {
                "id": "item_cmd",
                "type": "commandExecution",
                "status": "inProgress",
            },
            "outputDelta": "out",
        },
        "thread_1",
        "turn_1",
    )

    assert message == {
        "method": "item/commandExecution/outputDelta",
        "params": {
            "type": "item/commandExecution/outputDelta",
            "item": {
                "id": "item_cmd",
                "type": "commandExecution",
                "status": "inProgress",
            },
            "outputDelta": "out",
            "threadId": "thread_1",
            "turnId": "turn_1",
        },
    }


def test_codex_sdk_thread_ref_ignores_private_sdk_handles() -> None:
    lock = threading.Lock()

    dumped = thread_ref(_SdkThreadHandle(id="thread_1", _client=lock))

    assert dumped == {"id": "thread_1"}


def test_codex_runtime_model_catalog_from_app_server() -> None:
    asyncio.run(_test_codex_runtime_model_catalog_from_app_server())


async def _test_codex_runtime_model_catalog_from_app_server() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    catalog = await runtime.list_model_catalog()

    assert [model.id for model in catalog.models] == ["gpt-example", "gpt-plain"]
    assert catalog.models[0].selection_id is None
    assert catalog.models[0].description is None
    assert [item.id for item in catalog.models[0].reasoning_items] == ["low", "high"]
    assert catalog.models[0].reasoning_items[0].description is None
    assert catalog.models[0].reasoning_items[0].selection_id.startswith("sel_model_")
    assert catalog.models[1].selection_id.startswith("sel_model_")


def test_codex_runtime_model_catalog_query_and_limit() -> None:
    asyncio.run(_test_codex_runtime_model_catalog_query_and_limit())


async def _test_codex_runtime_model_catalog_query_and_limit() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    catalog = await runtime.list_model_catalog(query="plain", limit=1)

    assert [model.id for model in catalog.models] == ["gpt-plain"]


def test_codex_runtime_permission_catalog() -> None:
    asyncio.run(_test_codex_runtime_permission_catalog())


async def _test_codex_runtime_permission_catalog() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    all_permissions = await runtime.list_permission_catalog()
    catalog = await runtime.list_permission_catalog(query="full")

    assert [item.id for item in all_permissions.permissions] == [
        "request_approval",
        "auto_review",
        "full_access",
    ]
    request_permission = all_permissions.permissions[0]
    auto_review_permission = all_permissions.permissions[1]
    assert request_permission.metadata["nativeSettings"]["approvalPolicy"] == (
        "on-request"
    )
    assert request_permission.metadata["nativeSettings"]["approvalsReviewer"] == "user"
    assert auto_review_permission.metadata["nativeSettings"]["approvalPolicy"] == (
        "on-request"
    )
    assert (
        auto_review_permission.metadata["nativeSettings"]["approvalsReviewer"]
        == "auto_review"
    )
    assert [item.id for item in catalog.permissions] == ["full_access"]
    assert catalog.permissions[0].selection_id.startswith("sel_permission_")
    assert catalog.permissions[0].description is not None
    assert catalog.permissions[0].metadata["i18n"]["labelKey"] == (
        "dashboard.new.permissionModes.fullAccess.label"
    )
    assert (
        catalog.permissions[0].metadata["nativeSettings"]["sandbox"]
        == "danger-full-access"
    )


def test_codex_runtime_reports_runtime_capabilities() -> None:
    asyncio.run(_test_codex_runtime_reports_runtime_capabilities())


async def _test_codex_runtime_reports_runtime_capabilities() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    capability_set = await runtime.get_runtime_capabilities()
    capabilities = {
        capability.capability_id: capability
        for capability in capability_set.capabilities
    }

    assert capability_set.runtime == "codex"
    assert capability_set.revision == _config().revision
    assert capability_set.connector_id == "conn_test"
    assert capabilities[CAPABILITY_RUNTIME_CONFIG].available is True
    assert capabilities[CAPABILITY_CATALOG_MODEL].available is True


def test_codex_runtime_reports_unavailable_runtime_capabilities_without_client() -> None:
    asyncio.run(_test_codex_runtime_reports_unavailable_runtime_capabilities_without_client())


async def _test_codex_runtime_reports_unavailable_runtime_capabilities_without_client() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=None)

    capability_set = await runtime.get_runtime_capabilities()
    capabilities = {
        capability.capability_id: capability
        for capability in capability_set.capabilities
    }

    assert capabilities[CAPABILITY_RUNTIME_CONFIG].available is True
    assert capabilities[CAPABILITY_CATALOG_MODEL].available is False
    assert capabilities[CAPABILITY_CATALOG_MODEL].unavailable_reason == (
        "codex_unavailable"
    )


def test_codex_runtime_reports_idle_session_capabilities() -> None:
    asyncio.run(_test_codex_runtime_reports_idle_session_capabilities())


async def _test_codex_runtime_reports_idle_session_capabilities() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    capability_set = await runtime.get_session_capabilities("sess_1", "thread_1")
    capabilities = {
        capability.capability_id: capability
        for capability in capability_set.capabilities
    }

    assert capability_set.session_id == "sess_1"
    assert capabilities[CAPABILITY_SESSION_SEND_MESSAGE].available is True
    assert capabilities[CAPABILITY_SESSION_COMMANDS].available is True
    assert capabilities[CAPABILITY_SESSION_INTERRUPT].available is False
    assert capabilities[CAPABILITY_SESSION_INTERRUPT].unavailable_reason == (
        "no_active_turn"
    )
    assert capabilities[CAPABILITY_SESSION_STEER].available is False


def test_codex_runtime_reports_running_session_capabilities() -> None:
    asyncio.run(_test_codex_runtime_reports_running_session_capabilities())


async def _test_codex_runtime_reports_running_session_capabilities() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    await runtime.start_turn("sess_1", "thread_1", "hello")
    capability_set = await runtime.get_session_capabilities("sess_1", "thread_1")
    capabilities = {
        capability.capability_id: capability
        for capability in capability_set.capabilities
    }

    assert capabilities[CAPABILITY_SESSION_SEND_MESSAGE].available is False
    assert capabilities[CAPABILITY_SESSION_SEND_MESSAGE].unavailable_reason == (
        "session_running"
    )
    assert capabilities[CAPABILITY_SESSION_COMMANDS].available is False
    assert capabilities[CAPABILITY_SESSION_INTERRUPT].available is True
    assert capabilities[CAPABILITY_SESSION_STEER].available is True


def test_codex_runtime_reports_idle_after_no_active_turn() -> None:
    asyncio.run(_test_codex_runtime_reports_idle_after_no_active_turn())


async def _test_codex_runtime_reports_idle_after_no_active_turn() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    await runtime.start_turn("sess_1", "thread_1", "hello")
    await runtime.interrupt_turn("sess_1", "thread_1")
    capability_set = await runtime.get_session_capabilities("sess_1", "thread_1")
    capabilities = {
        capability.capability_id: capability
        for capability in capability_set.capabilities
    }

    assert capabilities[CAPABILITY_SESSION_SEND_MESSAGE].available is True
    assert capabilities[CAPABILITY_SESSION_INTERRUPT].available is False
    assert capabilities[CAPABILITY_SESSION_INTERRUPT].unavailable_reason == (
        "no_active_turn"
    )


def test_codex_runtime_lists_sessions_from_thread_list() -> None:
    asyncio.run(_test_codex_runtime_lists_sessions_from_thread_list())


async def _test_codex_runtime_lists_sessions_from_thread_list() -> None:
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())

    sessions = await runtime.list_sessions(limit=10)

    assert len(sessions) == 2
    assert sessions[0].session_id == stable_session_id("conn_test", "thread_1")
    assert sessions[0].external_session_id == "thread_1"
    assert sessions[0].title == "Fix tests"
    assert sessions[0].cwd == "/repo"
    assert sessions[0].ordering_time == "2026-08-02T00:00:00Z"
    assert sessions[0].metadata["local_state"] == "active"
    assert sessions[0].metadata["hidden"] is False
    assert sessions[0].metadata["sync"]["changed"] is True
    assert sessions[0].metadata["sync"]["requires_timeline_sync"] is True
    assert sessions[1].external_session_id == "thread_archived"
    assert sessions[1].metadata["local_state"] == "archived"
    assert sessions[1].metadata["hidden"] is True
    assert sessions[1].metadata["sync"]["requires_timeline_sync"] is False
    assert host.sync_states["codex/session-sync/thread_1"]["session_id"] == (
        stable_session_id("conn_test", "thread_1")
    )


def test_codex_runtime_session_sync_marker_skips_unchanged_timeline() -> None:
    asyncio.run(_test_codex_runtime_session_sync_marker_skips_unchanged_timeline())


async def _test_codex_runtime_session_sync_marker_skips_unchanged_timeline() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    first = await runtime.list_sessions(limit=10)
    second = await runtime.list_sessions(limit=10)
    restarted_runtime = CodexRuntime(config=_config(), host=host, client=client)
    after_restart = await restarted_runtime.list_sessions(limit=10)

    assert first[0].metadata["sync"]["requires_timeline_sync"] is True
    assert second[0].metadata["sync"]["changed"] is False
    assert second[0].metadata["sync"]["requires_timeline_sync"] is False
    assert after_restart[0].session_id == first[0].session_id
    assert after_restart[0].metadata["sync"]["changed"] is False
    assert all(request[0] != "thread/read" for request in client.requests)


def test_codex_runtime_session_sync_force_requires_timeline() -> None:
    asyncio.run(_test_codex_runtime_session_sync_force_requires_timeline())


async def _test_codex_runtime_session_sync_force_requires_timeline() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.list_sessions(limit=10)
    forced = await runtime.list_sessions(limit=10, force=True)

    assert forced[0].metadata["sync"]["changed"] is True
    assert forced[0].metadata["sync"]["requires_timeline_sync"] is True


def test_codex_runtime_session_sync_marker_allows_rename_only_meta_update() -> None:
    asyncio.run(
        _test_codex_runtime_session_sync_marker_allows_rename_only_meta_update()
    )


async def _test_codex_runtime_session_sync_marker_allows_rename_only_meta_update() -> (
    None
):
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.list_sessions(limit=10)
    client.results["thread/list"] = {
        "threads": [
            {
                "id": "thread_1",
                "name": "Renamed",
                "cwd": "/repo",
                "updatedAt": "2026-08-02T00:00:00Z",
            }
        ]
    }
    sessions = await runtime.list_sessions(limit=10)

    assert sessions[0].title == "Renamed"
    assert sessions[0].metadata["sync"]["changed"] is False
    assert sessions[0].metadata["sync"]["requires_timeline_sync"] is False
    assert host.sync_states["codex/session-sync/thread_1"]["title"] == "Renamed"


def test_codex_runtime_list_sessions_passes_cursor_to_runtime() -> None:
    asyncio.run(_test_codex_runtime_list_sessions_passes_cursor_to_runtime())


async def _test_codex_runtime_list_sessions_passes_cursor_to_runtime() -> None:
    client = FakeCodexClient()
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    await runtime.list_sessions(limit=5, cursor="next-page")

    assert client.requests[-1] == (
        "thread/list",
        {"limit": 5, "sortKey": "updated_at", "cursor": "next-page"},
    )


def test_codex_runtime_session_state_defaults_to_idle_for_known_external_session() -> (
    None
):
    asyncio.run(
        _test_codex_runtime_session_state_defaults_to_idle_for_known_external_session()
    )


async def _test_codex_runtime_session_state_defaults_to_idle_for_known_external_session() -> (
    None
):
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    state = await runtime.get_session_state("sess_1", external_session_id="thread_1")

    assert state is not None
    assert state.status == "idle"
    assert state.runtime == "codex"


def test_codex_runtime_reads_current_session_selections_from_thread() -> None:
    asyncio.run(_test_codex_runtime_reads_current_session_selections_from_thread())


async def _test_codex_runtime_reads_current_session_selections_from_thread() -> None:
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": {
            "id": "thread_1",
            "model": "gpt-example",
            "reasoningEffort": "high",
            "threadSettings": {
                "approvalPolicy": "on-request",
                "approvalsReviewer": "user",
                "sandboxPolicy": {"type": "workspaceWrite"},
            },
            "items": [],
        }
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)
    model_selection = (
        (await runtime.list_model_catalog()).models[0].reasoning_items[1].selection_id
    )
    permission_selection = (
        (await runtime.list_permission_catalog(query="request"))
        .permissions[0]
        .selection_id
    )

    state = await runtime.get_session_state("sess_1", external_session_id="thread_1")

    assert state is not None
    assert state.status == "idle"
    assert state.selections == {
        "model": model_selection,
        "permission": permission_selection,
    }
    assert client.requests[-1] == (
        "thread/read",
        {"threadId": "thread_1", "includeTurns": False},
    )


def test_codex_runtime_distinguishes_auto_review_selection_from_thread() -> None:
    asyncio.run(_test_codex_runtime_distinguishes_auto_review_selection_from_thread())


async def _test_codex_runtime_distinguishes_auto_review_selection_from_thread() -> None:
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": {
            "id": "thread_1",
            "threadSettings": {
                "approvalPolicy": "on-request",
                "approvalsReviewer": "auto_review",
                "sandboxPolicy": {"type": "workspaceWrite"},
            },
            "items": [],
        }
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)
    permission_selection = (
        (await runtime.list_permission_catalog(query="auto"))
        .permissions[0]
        .selection_id
    )

    state = await runtime.get_session_state("sess_1", external_session_id="thread_1")

    assert state is not None
    assert state.selections == {"permission": permission_selection}


def test_codex_runtime_reads_session_snapshot() -> None:
    asyncio.run(_test_codex_runtime_reads_session_snapshot())


async def _test_codex_runtime_reads_session_snapshot() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert snapshot.runtime == "codex"
    assert snapshot.external_session_id == "thread_1"
    assert [item.id for item in snapshot.items] == ["item_user", "item_assistant"]
    assert snapshot.items[0].content_hash.startswith("sha256:")
    assert snapshot.items[0].role == "user"
    assert snapshot.items[0].turn_id == "turn_1"
    assert snapshot.items[0].content == {"kind": "markdown", "text": "hello", "format": "markdown"}
    assert snapshot.items[1].content == {"kind": "markdown", "text": "hi", "format": "markdown"}


def test_codex_snapshot_reuses_live_assistant_identity() -> None:
    asyncio.run(_test_codex_snapshot_reuses_live_assistant_identity())


async def _test_codex_snapshot_reuses_live_assistant_identity() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "id": "msg_live",
                    "type": "agentMessage",
                    "status": "completed",
                    "role": "assistant",
                    "content": {"text": "same answer"},
                },
            },
        }
    )
    client.results["thread/read"] = {
        "thread": {
            "id": "thread_1",
            "items": [
                {
                    "id": "item-2",
                    "type": "agentMessage",
                    "status": "done",
                    "role": "assistant",
                    "content": {"text": "same answer"},
                }
            ],
        }
    }

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert host.timeline_item_upserts[-1].id == "msg_live"
    assert snapshot.items[0].id == "msg_live"
    assert snapshot.items[0].source["itemId"] == "item-2"


def test_codex_snapshot_reuses_live_user_identity_when_client_id_arrives_late() -> None:
    asyncio.run(_test_codex_snapshot_reuses_live_user_identity_when_client_id_arrives_late())


async def _test_codex_snapshot_reuses_live_user_identity_when_client_id_arrives_late() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "id": "live_user",
                    "type": "userMessage",
                    "status": "completed",
                    "role": "user",
                    "content": {"text": "same prompt"},
                },
            },
        }
    )
    client.results["thread/read"] = {
        "thread": {
            "id": "thread_1",
            "items": [
                {
                    "id": "item-1",
                    "type": "userMessage",
                    "status": "done",
                    "role": "user",
                    "clientMessageId": "msg_late",
                    "content": {"text": "same prompt"},
                }
            ],
        }
    }

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert host.timeline_item_upserts[-1].id == "live_user"
    assert snapshot.items[0].id == "live_user"
    assert snapshot.items[0].source["itemId"] == "item-1"
    assert snapshot.items[0].source["clientMessageId"] == "msg_late"


def test_codex_runtime_reads_user_message_text_elements_snapshot() -> None:
    asyncio.run(_test_codex_runtime_reads_user_message_text_elements_snapshot())


async def _test_codex_runtime_reads_user_message_text_elements_snapshot() -> None:
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": {
            "id": "thread_1",
            "items": [
                {
                    "id": "item_user",
                    "type": "userMessage",
                    "status": "done",
                    "content": {
                        "text_elements": [
                            {"type": "text", "text": "first"},
                            {"type": "text", "text": "second"},
                        ]
                    },
                },
            ],
        },
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert snapshot.items[0].role == "user"
    assert snapshot.items[0].content == {
        "kind": "markdown",
        "text": "first\nsecond",
        "format": "markdown",
    }


def test_codex_runtime_reads_nested_turn_snapshot() -> None:
    asyncio.run(_test_codex_runtime_reads_nested_turn_snapshot())


async def _test_codex_runtime_reads_nested_turn_snapshot() -> None:
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": {
            "id": "thread_1",
            "turns": [
                {
                    "items": [
                        {
                            "type": "message",
                            "role": "user",
                            "text": "nested",
                        }
                    ]
                }
            ],
        }
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert len(snapshot.items) == 1
    assert snapshot.items[0].id == "codex_thread_1_message-user-0"
    assert snapshot.items[0].content == {"kind": "markdown", "text": "nested", "format": "markdown"}


def test_codex_runtime_returns_empty_snapshot_without_external_session() -> None:
    asyncio.run(_test_codex_runtime_returns_empty_snapshot_without_external_session())


async def _test_codex_runtime_returns_empty_snapshot_without_external_session() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    snapshot = await runtime.get_session_snapshot("sess_1")

    assert snapshot.items == ()
    assert snapshot.complete is True


def test_codex_runtime_starts_existing_turn_and_reports_running_state() -> None:
    asyncio.run(_test_codex_runtime_starts_existing_turn_and_reports_running_state())


async def _test_codex_runtime_starts_existing_turn_and_reports_running_state() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.start_turn(
        "sess_1",
        "thread_1",
        "hello",
        client_message_id="cm_1",
    )

    assert result.ok is True
    assert result.result["turnId"] == "turn_new"
    assert client.requests[-1] == (
        "turn/start",
        {
            "threadId": "thread_1",
            "input": [{"type": "text", "text": "hello", "text_elements": []}],
            "clientUserMessageId": "cm_1",
        },
    )
    assert [update["status"] for update in host.state_updates[-2:]] == [
        "waiting",
        "running",
    ]
    state = await runtime.get_session_state("sess_1")
    assert state is not None
    assert state.status == "running"


def test_codex_runtime_does_not_restore_running_after_fast_terminal_turn() -> None:
    asyncio.run(_test_codex_runtime_does_not_restore_running_after_fast_terminal_turn())


async def _test_codex_runtime_does_not_restore_running_after_fast_terminal_turn() -> None:
    class FastTerminalCodexClient(FakeCodexClient):
        async def start_turn(self, request: CodexStartTurnRequest) -> CodexTurnResult:
            result = await super().start_turn(request)
            if self.handler is not None:
                await self.handler(
                    {
                        "method": "turn/completed",
                        "params": {
                            "platformSessionId": "sess_1",
                            "threadId": request.thread_id,
                            "turn": {
                                "id": result.turn_id,
                                "status": "completed",
                                "items": [],
                            },
                        },
                    }
                )
            return result

    client = FastTerminalCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.start_turn("sess_1", "thread_1", "hello")

    assert result.ok is True
    assert result.result["completed"] is True
    assert result.result["status"] == "idle"
    assert [update["status"] for update in host.state_updates] == ["waiting", "idle"]
    interrupt = await runtime.interrupt_turn("sess_1", "thread_1")
    assert interrupt.ok is False
    assert interrupt.code == "codex_no_active_turn"


def test_codex_runtime_terminal_event_without_platform_session_uses_cached_session() -> None:
    asyncio.run(
        _test_codex_runtime_terminal_event_without_platform_session_uses_cached_session()
    )


async def _test_codex_runtime_terminal_event_without_platform_session_uses_cached_session() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    await runtime._handle_notification(
        {
            "method": "turn/completed",
            "params": {
                "threadId": "thread_1",
                "turnId": "turn_new",
                "metadata": {"source": "codex.sdk.stream.finally"},
            },
        }
    )

    state = await runtime.get_session_state("sess_1")
    assert state is not None
    assert state.status == "idle"
    assert host.state_updates[-1]["session_id"] == "sess_1"
    assert host.state_updates[-1]["status"] == "idle"


def test_codex_runtime_create_and_start_session_reports_meta_and_state() -> None:
    asyncio.run(_test_codex_runtime_create_and_start_session_reports_meta_and_state())


async def _test_codex_runtime_create_and_start_session_reports_meta_and_state() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)
    model_selection = (
        (await runtime.list_model_catalog()).models[0].reasoning_items[0].selection_id
    )
    permission_selection = (
        (await runtime.list_permission_catalog(query="request"))
        .permissions[0]
        .selection_id
    )

    result = await runtime.create_and_start_session(
        session_id="sess_new",
        content="start",
        title="New",
        cwd="/repo",
        selections={
            "model": model_selection,
            "permission": permission_selection,
        },
        client_message_id="cm_new",
    )

    assert result.ok is True
    assert result.result["externalSessionId"] == "thread_new"
    thread_start = next(
        request for request in client.requests if request[0] == "thread/start"
    )
    assert thread_start[1]["cwd"] == "/repo"
    assert thread_start[1]["model"] == "gpt-example"
    assert thread_start[1]["approvalPolicy"] == "on-request"
    assert thread_start[1]["sandbox"] == "workspace-write"
    assert host.meta_upserts[0]["session_id"] == "sess_new"
    assert host.meta_upserts[0]["external_session_id"] == "thread_new"
    assert [update["status"] for update in host.state_updates] == [
        "idle",
        "waiting",
        "running",
    ]
    assert host.state_updates[0]["selections"] == {
        "model": model_selection,
        "permission": permission_selection,
    }


def test_codex_runtime_update_session_selections_pushes_runtime_state() -> None:
    asyncio.run(_test_codex_runtime_update_session_selections_pushes_runtime_state())


async def _test_codex_runtime_update_session_selections_pushes_runtime_state() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)
    model_selection = (
        (await runtime.list_model_catalog()).models[0].reasoning_items[1].selection_id
    )
    permission_selection = (
        (await runtime.list_permission_catalog(query="full"))
        .permissions[0]
        .selection_id
    )

    result = await runtime.update_session_selections(
        "sess_1",
        "thread_1",
        {"model": model_selection, "permission": permission_selection},
    )

    assert result.ok is True
    assert result.result["updated"] is True
    assert all(request[0] != "thread/update" for request in client.requests)
    assert host.state_updates[-1]["status"] == "idle"
    assert host.state_updates[-1]["selections"] == {
        "model": model_selection,
        "permission": permission_selection,
    }
    assert host.state_updates[-1]["metadata"]["source"] == (
        "codex.session.selections.update"
    )
    assert host.state_updates[-1]["metadata"]["selection_effect"] == "next_turn"


def test_codex_runtime_update_session_selections_allows_platform_only_session() -> None:
    asyncio.run(
        _test_codex_runtime_update_session_selections_allows_platform_only_session()
    )


async def _test_codex_runtime_update_session_selections_allows_platform_only_session() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)
    model_selection = (await runtime.list_model_catalog()).models[1].selection_id

    result = await runtime.update_session_selections(
        "sess_platform_only",
        None,
        {"model": model_selection},
    )

    assert result.ok is True
    assert result.result["externalSessionId"] is None
    assert host.state_updates[-1]["session_id"] == "sess_platform_only"
    assert host.state_updates[-1]["external_session_id"] is None
    assert host.state_updates[-1]["selections"] == {"model": model_selection}
    assert host.state_updates[-1]["metadata"]["selection_effect"] == "next_turn"


def test_codex_runtime_invalid_selection_returns_protocol_error() -> None:
    asyncio.run(_test_codex_runtime_invalid_selection_returns_protocol_error())


async def _test_codex_runtime_invalid_selection_returns_protocol_error() -> None:
    client = FakeCodexClient()
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    result = await runtime.update_session_selections(
        "sess_1",
        "thread_1",
        {"model": "sel_model_missing"},
    )

    assert result.ok is False
    assert result.code == "codex_invalid_selection"
    assert "unknown Codex model selection" in str(result.message)
    assert all(request[0] != "thread/update" for request in client.requests)


def test_codex_runtime_start_turn_carries_cached_session_selections() -> None:
    asyncio.run(_test_codex_runtime_start_turn_carries_cached_session_selections())


async def _test_codex_runtime_start_turn_carries_cached_session_selections() -> None:
    client = FakeCodexClient()
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)
    model_selection = (
        (await runtime.list_model_catalog()).models[0].reasoning_items[1].selection_id
    )
    permission_selection = (
        (await runtime.list_permission_catalog(query="full"))
        .permissions[0]
        .selection_id
    )

    update = await runtime.update_session_selections(
        "sess_1",
        "thread_1",
        {"model": model_selection, "permission": permission_selection},
    )
    result = await runtime.start_turn("sess_1", "thread_1", "hello")

    assert update.ok is True
    assert result.ok is True
    assert all(
        request[0] not in {"thread/update", "thread/settings/update"}
        for request in client.requests
    )
    turn_start = next(
        request for request in reversed(client.requests) if request[0] == "turn/start"
    )
    assert turn_start[1]["model"] == "gpt-example"
    assert turn_start[1]["effort"] == "high"
    assert turn_start[1]["approvalPolicy"] == "never"
    assert turn_start[1]["sandbox"] == "danger-full-access"


def test_codex_runtime_lists_compact_command_for_loaded_thread() -> None:
    asyncio.run(_test_codex_runtime_lists_compact_command_for_loaded_thread())


async def _test_codex_runtime_lists_compact_command_for_loaded_thread() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    commands = await runtime.list_commands(
        "sess_1",
        external_session_id="thread_1",
        query="comp",
    )

    assert [command.id for command in commands] == ["compact"]
    assert commands[0].enabled is True
    assert commands[0].disabled_reason is None


def test_codex_runtime_lists_disabled_compact_command_without_thread() -> None:
    asyncio.run(_test_codex_runtime_lists_disabled_compact_command_without_thread())


async def _test_codex_runtime_lists_disabled_compact_command_without_thread() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    commands = await runtime.list_commands("sess_1", query="compact")

    assert [command.id for command in commands] == ["compact"]
    assert commands[0].enabled is False
    assert commands[0].disabled_reason == (
        "Codex compact requires a loaded local thread."
    )


def test_codex_runtime_compact_command_calls_app_server() -> None:
    asyncio.run(_test_codex_runtime_compact_command_calls_app_server())


async def _test_codex_runtime_compact_command_calls_app_server() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.execute_command(
        "sess_1",
        "compact",
        external_session_id="thread_1",
        raw="/compact",
    )

    assert result.ok is True
    assert result.command == "compact"
    assert result.code == "started"
    assert result.result == {
        "externalSessionId": "thread_1",
        "scheduled": True,
    }
    assert host.notice_upserts == []
    assert host.timeline_item_upserts[-1].type == "system"
    assert host.timeline_item_upserts[-1].status == "running"
    assert host.timeline_item_upserts[-1].content["kind"] == "compact"
    assert host.timeline_item_upserts[-1].content["state"] == "started"
    started_item_id = host.timeline_item_upserts[-1].id
    assert host.state_updates[-1]["status"] == "blocked"
    assert host.state_updates[-1]["metadata"] == {
        "source": "codex.command.compact",
        "command": "compact",
        "result": {},
    }
    blocked_capabilities = capability_map(host.session_capability_updates[-1])
    assert blocked_capabilities[CAPABILITY_SESSION_SEND_MESSAGE].available is False
    assert blocked_capabilities[CAPABILITY_SESSION_COMMANDS].available is False

    await wait_for_compact_tasks(runtime)

    assert client.requests[-1] == (
        "thread/compact/start",
        {"threadId": "thread_1"},
    )
    assert all(request[0] != "turn/start" for request in client.requests)
    assert host.timeline_item_upserts[-1].id == started_item_id
    assert host.timeline_item_upserts[-1].status == "done"
    assert host.timeline_item_upserts[-1].content["kind"] == "compact"
    assert host.timeline_item_upserts[-1].content["state"] == "completed"
    assert host.state_updates[-1]["status"] == "idle"
    assert host.state_updates[-1]["metadata"]["source"] == "codex.command.compact.accepted"
    idle_capabilities = capability_map(host.session_capability_updates[-1])
    assert idle_capabilities[CAPABILITY_SESSION_SEND_MESSAGE].available is True
    assert idle_capabilities[CAPABILITY_SESSION_COMMANDS].available is True

    await runtime._handle_notification(
        Notification(
            method="thread/compacted",
            payload=ContextCompactedNotification(
                threadId="thread_1",
                turnId="turn_compact",
            ),
        )
    )

    assert host.timeline_item_upserts[-1].id == started_item_id
    assert host.timeline_item_upserts[-1].status == "done"
    assert host.timeline_item_upserts[-1].content["kind"] == "compact"
    assert host.timeline_item_upserts[-1].content["state"] == "completed"
    assert host.state_updates[-1]["status"] == "idle"
    assert host.state_updates[-1]["metadata"]["source"] == "codex.thread/compacted"


def test_codex_runtime_rejects_disabled_command_without_sdk_request() -> None:
    asyncio.run(_test_codex_runtime_rejects_disabled_command_without_sdk_request())


async def _test_codex_runtime_rejects_disabled_command_without_sdk_request() -> None:
    client = FakeCodexClient()
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    result = await runtime.execute_command("sess_1", "compact")

    assert result.ok is False
    assert result.command == "compact"
    assert result.code == "command_disabled"
    assert result.message == "Codex compact requires a loaded local thread."
    assert all(request[0] != "thread/compact/start" for request in client.requests)


def test_codex_runtime_rejects_command_args_without_sdk_request() -> None:
    asyncio.run(_test_codex_runtime_rejects_command_args_without_sdk_request())


async def _test_codex_runtime_rejects_command_args_without_sdk_request() -> None:
    client = FakeCodexClient()
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    result = await runtime.execute_command(
        "sess_1",
        "compact",
        external_session_id="thread_1",
        args=("now",),
    )

    assert result.ok is False
    assert result.command == "compact"
    assert result.code == "arguments_not_supported"
    assert result.message == "/compact does not accept arguments."
    assert all(request[0] != "thread/compact/start" for request in client.requests)


async def wait_for_compact_tasks(runtime: CodexRuntime) -> None:
    tasks = tuple(runtime._turns.commands.compact_tasks)
    if tasks:
        await asyncio.gather(*tasks)


def capability_map(capabilities: RuntimeCapabilitySet) -> dict[str, Any]:
    return {
        capability.capability_id: capability
        for capability in capabilities.capabilities
    }


def test_codex_runtime_command_failure_publishes_async_failure() -> None:
    asyncio.run(_test_codex_runtime_command_failure_publishes_async_failure())


async def _test_codex_runtime_command_failure_publishes_async_failure() -> None:
    client = FakeCodexClient()
    client.results["thread/compact/start"] = RuntimeError("compact failed")
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.execute_command(
        "sess_1",
        "compact",
        external_session_id="thread_1",
    )

    assert result.ok is True
    assert result.command == "compact"
    assert result.code == "started"

    await wait_for_compact_tasks(runtime)

    assert host.notice_upserts == []
    assert host.timeline_item_upserts[-1].content["kind"] == "compact"
    assert host.timeline_item_upserts[-1].content["state"] == "failed"
    assert host.state_updates[-1]["status"] == "idle"
    assert host.state_updates[-1]["error"] == {
        "code": "RuntimeError",
        "message": "compact failed",
    }


def test_codex_runtime_compact_thread_not_found_sets_idle() -> None:
    asyncio.run(_test_codex_runtime_compact_thread_not_found_sets_idle())


async def _test_codex_runtime_compact_thread_not_found_sets_idle() -> None:
    client = FakeCodexClient()
    client.results["thread/compact/start"] = RuntimeError(
        '{"message": "thread not found: thread_1"}'
    )
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.execute_command(
        "sess_1",
        "compact",
        external_session_id="thread_1",
    )

    assert result.ok is True
    assert result.command == "compact"
    assert result.code == "started"

    await wait_for_compact_tasks(runtime)

    assert host.state_updates[-1]["status"] == "idle"
    assert host.state_updates[-1]["metadata"]["source"] == "codex.command.compact.soft-failed"
    assert host.state_updates[-1]["metadata"]["reason"] == "thread_not_found"
    assert host.state_updates[-1]["metadata"]["command"] == "compact"


def test_codex_runtime_compact_thread_not_found_request_error_sets_idle() -> None:
    asyncio.run(_test_codex_runtime_compact_thread_not_found_request_error_sets_idle())


async def _test_codex_runtime_compact_thread_not_found_request_error_sets_idle() -> None:
    client = FakeCodexClient()
    client.results["thread/compact/start"] = RuntimeInvalidRequestError(
        "thread not found: thread_1"
    )
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.execute_command(
        "sess_1",
        "compact",
        external_session_id="thread_1",
    )

    assert result.ok is True
    assert result.command == "compact"
    assert result.code == "started"

    await wait_for_compact_tasks(runtime)

    assert host.state_updates[-1]["status"] == "idle"


def test_codex_runtime_rejects_unknown_command_without_transport_error() -> None:
    asyncio.run(_test_codex_runtime_rejects_unknown_command_without_transport_error())


async def _test_codex_runtime_rejects_unknown_command_without_transport_error() -> None:
    client = FakeCodexClient()
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    result = await runtime.execute_command(
        "sess_1", "nope", external_session_id="thread_1"
    )

    assert result.ok is False
    assert result.code == "unknown_command"
    assert all(request[0] != "turn/start" for request in client.requests)


def test_codex_runtime_turn_completed_notification_sets_idle() -> None:
    asyncio.run(_test_codex_runtime_turn_completed_notification_sets_idle())


async def _test_codex_runtime_turn_completed_notification_sets_idle() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "turn/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
            },
        }
    )

    assert host.state_updates[-1]["status"] == "idle"
    state = await runtime.get_session_state("sess_1")
    assert state is not None
    assert state.status == "idle"


def test_codex_runtime_item_event_without_start_marks_running_and_interruptible() -> (
    None
):
    asyncio.run(
        _test_codex_runtime_item_event_without_start_marks_running_and_interruptible()
    )


async def _test_codex_runtime_item_event_without_start_marks_running_and_interruptible() -> (
    None
):
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/started",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_event",
                "item": {
                    "id": "item_tool",
                    "type": "commandExecution",
                    "status": "inProgress",
                    "command": "pwd",
                },
            },
        }
    )
    result = await runtime.interrupt_turn("sess_1", "thread_1")

    assert host.state_updates[-2]["status"] == "running"
    assert host.state_updates[-2]["metadata"]["turn_id"] == "turn_event"
    assert result.ok is True
    assert client.requests[-1] == (
        "turn/interrupt",
        {
            "threadId": "thread_1",
            "turnId": "turn_event",
        },
    )


def test_codex_runtime_tool_delta_keeps_session_running() -> None:
    asyncio.run(_test_codex_runtime_tool_delta_keeps_session_running())


async def _test_codex_runtime_tool_delta_keeps_session_running() -> None:
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/commandExecution/outputDelta",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_tool",
                "itemId": "item_tool",
                "outputDelta": "running",
            },
        }
    )

    assert host.timeline_item_upserts[-1].type == "tool"
    assert host.state_updates[-1]["status"] == "running"
    assert host.state_updates[-1]["metadata"]["turn_id"] == "turn_tool"


def test_codex_runtime_agent_message_delta_upserts_timeline_item() -> None:
    asyncio.run(_test_codex_runtime_agent_message_delta_upserts_timeline_item())


async def _test_codex_runtime_agent_message_delta_upserts_timeline_item() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/agentMessage/delta",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "item_agent",
                "delta": "hel",
            },
        }
    )
    await runtime._handle_notification(
        {
            "method": "item/agentMessage/delta",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "item_agent",
                "delta": "lo",
            },
        }
    )

    assert len(host.timeline_item_upserts) == 2
    first, second = host.timeline_item_upserts
    assert first.id == "item_agent"
    assert first.order_seq == second.order_seq
    assert second.type == "message"
    assert second.role == "assistant"
    assert second.status == "running"
    assert second.turn_id == "turn_1"
    assert second.content == {"kind": "markdown", "text": "hello", "format": "markdown"}
    assert second.source["event"] == "item/agentMessage/delta"


def test_codex_runtime_agent_message_native_id_overrides_text_identity() -> None:
    asyncio.run(_test_codex_runtime_agent_message_native_id_overrides_text_identity())


async def _test_codex_runtime_agent_message_native_id_overrides_text_identity() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/agentMessage/delta",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "msg_old",
                "delta": "same text",
            },
        }
    )
    await runtime._handle_notification(
        {
            "method": "item/agentMessage/delta",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "msg_new",
                "delta": "same text",
            },
        }
    )

    assert host.timeline_item_upserts[-2].id == "msg_old"
    assert host.timeline_item_upserts[-1].id == "msg_new"
    assert host.timeline_item_upserts[-1].source["itemId"] == "msg_new"


def test_codex_runtime_reasoning_item_maps_to_system_timeline_item() -> None:
    asyncio.run(_test_codex_runtime_reasoning_item_maps_to_system_timeline_item())


async def _test_codex_runtime_reasoning_item_maps_to_system_timeline_item() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/started",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "item_reasoning",
                "item": {
                    "id": "item_reasoning",
                    "type": "reasoning",
                    "summary": "thinking",
                },
            },
        }
    )

    item = host.timeline_item_upserts[-1]
    assert item.type == "system"
    assert item.role == "system"
    assert item.content == {
        "kind": "reasoning",
        "text": "thinking",
        "format": "markdown",
    }


def test_codex_runtime_reduces_agent_message_snapshot_without_native_type_leak() -> (
    None
):
    asyncio.run(
        _test_codex_runtime_reduces_agent_message_snapshot_without_native_type_leak()
    )


async def _test_codex_runtime_reduces_agent_message_snapshot_without_native_type_leak() -> (
    None
):
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": {
            "id": "thread_1",
            "items": [
                {
                    "id": "item_agent",
                    "type": "agentMessage",
                    "text": "hello",
                    "status": "completed",
                }
            ],
        }
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    snapshot = await runtime.get_session_snapshot("sess_1", "thread_1")

    item = snapshot.items[0]
    assert item.type == "message"
    assert item.role == "assistant"
    assert item.status == "done"
    assert item.content == {"kind": "markdown", "text": "hello", "format": "markdown"}
    assert item.source["rawType"] == "agentMessage"


def test_codex_runtime_reduces_command_completion_and_failure() -> None:
    asyncio.run(_test_codex_runtime_reduces_command_completion_and_failure())


async def _test_codex_runtime_reduces_command_completion_and_failure() -> None:
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "id": "cmd_1",
                    "type": "commandExecution",
                    "command": "pytest -q",
                    "aggregatedOutput": "ok",
                    "status": "completed",
                },
            },
        }
    )
    await runtime._handle_notification(
        {
            "method": "item/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "id": "cmd_2",
                    "type": "commandExecution",
                    "command": "false",
                    "output": "failed",
                    "exitCode": 1,
                    "status": "failed",
                },
            },
        }
    )

    done, failed = host.timeline_item_upserts[-2:]
    assert done.type == "tool"
    assert done.role == "tool"
    assert done.status == "done"
    assert done.content == {
        "kind": "command",
        "command": "pytest -q",
        "output": "ok",
        "format": "text",
    }
    assert failed.type == "tool"
    assert failed.status == "failed"
    assert failed.content == {
        "kind": "command",
        "command": "false",
        "output": "failed",
        "format": "text",
        "exitCode": 1,
    }


def test_codex_runtime_reduces_function_call_and_tool_output() -> None:
    asyncio.run(_test_codex_runtime_reduces_function_call_and_tool_output())


async def _test_codex_runtime_reduces_function_call_and_tool_output() -> None:
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/started",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "id": "call_1",
                    "type": "function_call",
                    "name": "web_search",
                    "arguments": {"query": "Agents Anywhere"},
                    "status": "inProgress",
                },
            },
        }
    )
    await runtime._handle_notification(
        {
            "method": "item/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "id": "out_1",
                    "type": "function_call_output",
                    "output": "result text",
                    "status": "completed",
                },
            },
        }
    )

    call, output = host.timeline_item_upserts[-2:]
    assert call.type == "tool"
    assert call.content == {
        "kind": "web_search",
        "function": "web_search",
        "query": "Agents Anywhere",
        "arguments": {"query": "Agents Anywhere"},
    }
    assert output.type == "tool"
    assert output.status == "done"
    assert output.content == {
        "kind": "tool_result",
        "result": "result text",
        "output": "result text",
        "error": None,
    }


def test_codex_runtime_reduces_file_change_patch_as_artifact() -> None:
    asyncio.run(_test_codex_runtime_reduces_file_change_patch_as_artifact())


async def _test_codex_runtime_reduces_file_change_patch_as_artifact() -> None:
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/fileChange/patchUpdated",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "file_1",
                "path": "app.py",
                "action": "modify",
                "patch": "+print('hi')",
            },
        }
    )

    item = host.timeline_item_upserts[-1]
    assert item.type == "artifact"
    assert item.role is None
    assert item.status == "running"
    assert item.content == {
        "kind": "file_change",
        "path": "app.py",
        "action": "modify",
        "patch": "+print('hi')",
    }


def test_codex_runtime_reduces_runtime_and_unknown_items_safely() -> None:
    asyncio.run(_test_codex_runtime_reduces_runtime_and_unknown_items_safely())


async def _test_codex_runtime_reduces_runtime_and_unknown_items_safely() -> None:
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/runtimeMessage",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "message": "runtime warning",
            },
        }
    )
    await runtime._handle_notification(
        {
            "method": "item/started",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "id": "mystery_1",
                    "type": "mysteryNativeType",
                    "payload": {"x": 1},
                },
            },
        }
    )

    runtime_item, unknown_item = host.timeline_item_upserts[-2:]
    assert runtime_item.type == "system"
    assert runtime_item.role == "system"
    assert runtime_item.content == {
        "kind": "runtime",
        "text": "runtime warning",
        "format": "markdown",
    }
    assert unknown_item.type == "system"
    assert unknown_item.role is None
    assert unknown_item.content == {
        "kind": "unknown",
        "rawType": "mysteryNativeType",
    }
    assert unknown_item.source["rawType"] == "mysteryNativeType"


def test_codex_runtime_completed_turn_syncs_timeline_snapshot() -> None:
    asyncio.run(_test_codex_runtime_completed_turn_syncs_timeline_snapshot())


async def _test_codex_runtime_completed_turn_syncs_timeline_snapshot() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "turn/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turn": {
                    "id": "turn_done",
                    "items": [
                        {
                            "id": "item_user",
                            "type": "userMessage",
                            "text": "hi",
                            "status": "completed",
                        },
                        {
                            "id": "item_agent",
                            "type": "agentMessage",
                            "text": "hello",
                            "status": "completed",
                        },
                    ],
                },
            },
        }
    )

    assert len(host.timeline_syncs) == 1
    sync = host.timeline_syncs[0]
    assert sync["session_id"] == "sess_1"
    assert sync["external_session_id"] == "thread_1"
    assert sync["complete"] is False
    assert [item.id for item in sync["items"]] == [
        "item_user",
        "item_agent",
        "codex_turn_end_turn_done",
    ]
    assert [item.role for item in sync["items"]] == ["user", "assistant", "system"]
    assert [item.type for item in sync["items"]] == [
        "message",
        "message",
        "turn.end",
    ]
    assert [item.status for item in sync["items"]] == ["done", "done", "done"]
    assert host.state_updates[-1]["status"] == "idle"


def test_codex_runtime_interrupted_and_cancelled_turns_set_idle() -> None:
    asyncio.run(_test_codex_runtime_interrupted_and_cancelled_turns_set_idle())


async def _test_codex_runtime_interrupted_and_cancelled_turns_set_idle() -> None:
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())

    await runtime.start_turn("sess_1", "thread_1", "hello")
    await runtime._handle_notification(
        {
            "method": "turn/interrupted",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_new",
            },
        }
    )
    await runtime.start_turn("sess_1", "thread_1", "again")
    await runtime._handle_notification(
        {
            "method": "turn/cancelled",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_new",
            },
        }
    )

    idle_sources = [
        update["metadata"]["source"]
        for update in host.state_updates
        if update["status"] == "idle"
    ]
    assert "codex.turn/interrupted" in idle_sources
    assert "codex.turn/cancelled" in idle_sources


def test_codex_runtime_failed_turn_creates_blocking_error_notice() -> None:
    asyncio.run(_test_codex_runtime_failed_turn_creates_blocking_error_notice())


async def _test_codex_runtime_failed_turn_creates_blocking_error_notice() -> None:
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())

    await runtime.start_turn("sess_1", "thread_1", "hello")
    await runtime._handle_notification(
        {
            "method": "turn/failed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_new",
                "error": {
                    "code": "boom",
                    "message": "Exploded",
                },
            },
        }
    )
    interrupt = await runtime.interrupt_turn("sess_1", "thread_1")

    notice = host.notice_upserts[-1]
    assert notice.type == "interaction"
    assert notice.interaction_type == "execution_error"
    assert notice.severity == "error"
    assert notice.blocking == {"scope": "session", "targetId": "sess_1"}
    assert host.state_updates[-1]["status"] == "idle"
    assert interrupt.ok is False
    assert interrupt.code == "codex_no_active_turn"
    blocked_update = next(
        update
        for update in reversed(host.state_updates)
        if update["status"] == "blocked"
    )
    assert blocked_update["error"]["code"] == "boom"


def test_codex_runtime_tags_completed_user_echo_with_client_message_id() -> None:
    asyncio.run(_test_codex_runtime_tags_completed_user_echo_with_client_message_id())


async def _test_codex_runtime_tags_completed_user_echo_with_client_message_id() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn(
        "sess_1",
        "thread_1",
        "hello from web",
        client_message_id="cm_web_1",
    )
    await runtime._handle_notification(
        {
            "method": "turn/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turn": {
                    "id": "turn_new",
                    "items": [
                        {
                            "type": "userMessage",
                            "text": "hello from web",
                            "status": "completed",
                        },
                    ],
                },
            },
        }
    )

    item = host.timeline_syncs[-1]["items"][0]
    assert item.id == "codex_client_cm_web_1"
    assert item.source["clientMessageId"] == "cm_web_1"
    assert item.source["derivedKey"].startswith("userMessage-")


def test_codex_runtime_remembers_completed_user_echo_client_message_id() -> None:
    asyncio.run(
        _test_codex_runtime_remembers_completed_user_echo_client_message_id()
    )


async def _test_codex_runtime_remembers_completed_user_echo_client_message_id() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn(
        "sess_1",
        "thread_1",
        "hello from web",
        client_message_id="cm_web_1",
    )
    notification = {
        "method": "turn/completed",
        "params": {
            "platformSessionId": "sess_1",
            "threadId": "thread_1",
            "turn": {
                "id": "turn_new",
                "items": [
                    {
                        "id": "item_user",
                        "type": "userMessage",
                        "text": "hello from web",
                        "status": "completed",
                    },
                ],
            },
        },
    }

    await runtime._handle_notification(notification)
    await runtime._handle_notification(notification)

    first = host.timeline_syncs[-2]["items"][0]
    second = host.timeline_syncs[-1]["items"][0]
    assert first.id == "codex_client_cm_web_1"
    assert second.id == "codex_client_cm_web_1"
    assert first.source["clientMessageId"] == "cm_web_1"
    assert second.source["clientMessageId"] == "cm_web_1"


def test_codex_runtime_tags_live_user_echo_with_client_message_id() -> None:
    asyncio.run(_test_codex_runtime_tags_live_user_echo_with_client_message_id())


async def _test_codex_runtime_tags_live_user_echo_with_client_message_id() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn(
        "sess_1",
        "thread_1",
        "live hello",
        client_message_id="cm_live_1",
    )
    await runtime._handle_notification(
        {
            "method": "item/started",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_new",
                "item": {
                    "type": "userMessage",
                    "text": "live hello",
                },
            },
        }
    )

    item = host.timeline_item_upserts[-1]
    assert item.id == "codex_client_cm_live_1"
    assert item.source["clientMessageId"] == "cm_live_1"
    assert item.role == "user"
    assert item.content == {"kind": "markdown", "text": "live hello", "format": "markdown"}


def test_codex_runtime_tags_live_steer_echo_with_client_message_id() -> None:
    asyncio.run(_test_codex_runtime_tags_live_steer_echo_with_client_message_id())


async def _test_codex_runtime_tags_live_steer_echo_with_client_message_id() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "start")
    await runtime.steer_turn(
        "sess_1",
        "thread_1",
        "more context",
        client_message_id="cm_steer_1",
    )
    await runtime._handle_notification(
        {
            "method": "item/started",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_new",
                "item": {
                    "type": "steeringUserMessage",
                    "text": "more context",
                },
            },
        }
    )

    item = host.timeline_item_upserts[-1]
    assert item.id == "codex_client_cm_steer_1"
    assert item.source["clientMessageId"] == "cm_steer_1"
    assert item.source["rawType"] == "steeringUserMessage"
    assert item.role == "user"


def test_codex_runtime_snapshot_and_live_use_same_sdk_item_identity() -> None:
    asyncio.run(_test_codex_runtime_snapshot_and_live_use_same_sdk_item_identity())


async def _test_codex_runtime_snapshot_and_live_use_same_sdk_item_identity() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    client.results["thread/read"] = {
        "thread": {
            "id": "thread_1",
            "items": [
                {
                    "id": "sdk_item_1",
                    "type": "agentMessage",
                    "text": "hello",
                    "status": "completed",
                }
            ],
        }
    }
    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )
    await runtime.start()
    await runtime._handle_notification(
        {
            "method": "item/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "item": {
                    "id": "sdk_item_1",
                    "type": "agentMessage",
                    "text": "hello",
                    "status": "completed",
                },
            },
        }
    )

    live_item = host.timeline_item_upserts[-1]
    assert snapshot.items[0].id == live_item.id == "sdk_item_1"
    assert snapshot.items[0].content_hash == live_item.content_hash
    assert snapshot.items[0].source["derivedKey"] == live_item.source["derivedKey"]


def test_codex_sdk_stream_finally_emits_completed_when_sdk_omits_it() -> None:
    asyncio.run(_test_codex_sdk_stream_finally_emits_completed_when_sdk_omits_it())


async def _test_codex_sdk_stream_finally_emits_completed_when_sdk_omits_it() -> None:
    emitted: list[Any] = []
    client = CodexSdkClient(_FakeSdkClient())

    async def handler(message: Any) -> None:
        emitted.append(message)

    await client.start(handler)

    await client._stream_turn("thread_1", "turn_1", _FakeSdkTurn())

    assert [_notification_method(message) for message in emitted] == [
        "item/agentMessage/delta",
        "turn/completed",
    ]
    assert emitted[-1]["params"]["metadata"] == {"source": "codex.sdk.stream.finally"}


def test_codex_runtime_approval_request_upserts_session_notice() -> None:
    asyncio.run(_test_codex_runtime_approval_request_upserts_session_notice())


async def _test_codex_runtime_approval_request_upserts_session_notice() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "jsonrpc": "2.0",
            "id": 42,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "item_cmd",
                "approvalId": "appr_cmd",
                "command": "ls -la",
            },
        }
    )

    assert len(host.notice_upserts) == 1
    notice = host.notice_upserts[0]
    assert notice.notice_id == "notice_approval_appr_cmd"
    assert notice.type == "interaction"
    assert notice.interaction_type == "approval"
    assert notice.blocking == {"scope": "session", "targetId": "sess_1"}
    assert notice.response_required is True
    assert notice.source == {"approvalId": "appr_cmd", "timelineItemId": "item_cmd"}
    assert notice.context["approvalId"] == "appr_cmd"
    assert notice.context["approvalStatus"] == "pending"
    assert notice.context["approvalSource"] == {
        "requestId": 42,
        "method": "item/commandExecution/requestApproval",
        "threadId": "thread_1",
        "turnId": "turn_1",
        "itemId": "item_cmd",
    }
    assert notice.context["turnId"] == "turn_1"
    assert notice.context["command"] == "ls -la"
    assert host.state_updates[-1]["status"] == "blocked"
    assert host.state_updates[-1]["metadata"]["notice_id"] == "notice_approval_appr_cmd"
    assert [action["actionId"] for action in notice.actions] == [
        "approve",
        "approve_for_session",
        "reject",
    ]


def test_codex_runtime_steers_active_turn() -> None:
    asyncio.run(_test_codex_runtime_steers_active_turn())


async def _test_codex_runtime_steers_active_turn() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    result = await runtime.steer_turn(
        "sess_1",
        "thread_1",
        "more context",
        client_message_id="cm_steer",
    )

    assert result.ok is True
    assert result.result["steered"] is True
    assert result.result["turnId"] == "turn_new"
    assert client.requests[-1] == (
        "turn/steer",
        {
            "threadId": "thread_1",
            "input": [{"type": "text", "text": "more context", "text_elements": []}],
            "expectedTurnId": "turn_new",
            "clientUserMessageId": "cm_steer",
        },
    )
    assert host.state_updates[-1]["status"] == "running"


def test_codex_runtime_steer_without_active_turn_returns_conflict() -> None:
    asyncio.run(_test_codex_runtime_steer_without_active_turn_returns_conflict())


async def _test_codex_runtime_steer_without_active_turn_returns_conflict() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.steer_turn("sess_1", "thread_1", "late")

    assert result.ok is False
    assert result.code == "codex_no_active_turn"
    assert all(request[0] != "turn/steer" for request in client.requests)
    assert host.state_updates[-1]["status"] == "idle"


def test_codex_runtime_steer_no_active_sdk_turn_sets_idle() -> None:
    asyncio.run(_test_codex_runtime_steer_no_active_sdk_turn_sets_idle())


async def _test_codex_runtime_steer_no_active_sdk_turn_sets_idle() -> None:
    client = FakeCodexClient()
    client.results["turn/steer"] = RuntimeInvalidRequestError(
        "Codex SDK has no active turn for thread thread_1"
    )
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    result = await runtime.steer_turn("sess_1", "thread_1", "late")

    assert result.ok is False
    assert result.code == "turn_not_found"
    assert result.result["steered"] is False
    assert host.state_updates[-1]["status"] == "idle"
    assert (
        host.state_updates[-1]["metadata"]["source"]
        == "codex.turn/steer.soft-failed"
    )


def test_codex_runtime_interrupts_active_turn_and_sets_idle() -> None:
    asyncio.run(_test_codex_runtime_interrupts_active_turn_and_sets_idle())


async def _test_codex_runtime_interrupts_active_turn_and_sets_idle() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    result = await runtime.interrupt_turn("sess_1", "thread_1")
    second = await runtime.interrupt_turn("sess_1", "thread_1")

    assert result.ok is True
    assert result.result["interrupted"] is True
    assert client.requests[-1] == (
        "turn/interrupt",
        {
            "threadId": "thread_1",
            "turnId": "turn_new",
        },
    )
    assert host.state_updates[-1]["status"] == "idle"
    assert second.ok is False
    assert second.code == "codex_no_active_turn"
    assert (
        host.state_updates[-1]["metadata"]["source"]
        == "codex.turn/interrupt.no-active-turn"
    )
    capabilities = capability_map(host.session_capability_updates[-1])
    assert capabilities[CAPABILITY_SESSION_SEND_MESSAGE].available is True
    assert capabilities[CAPABILITY_SESSION_INTERRUPT].available is False
    assert capabilities[CAPABILITY_SESSION_INTERRUPT].unavailable_reason == (
        "no_active_turn"
    )


def test_codex_runtime_interrupt_soft_failure_sets_idle() -> None:
    asyncio.run(_test_codex_runtime_interrupt_soft_failure_sets_idle())


async def _test_codex_runtime_interrupt_soft_failure_sets_idle() -> None:
    client = FakeCodexClient()
    client.results["turn/interrupt"] = RuntimeError('{"message": "turn not found"}')
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    result = await runtime.interrupt_turn("sess_1", "thread_1")

    assert result.ok is False
    assert result.code == "turn_not_found"
    assert result.result["interrupted"] is False
    assert host.state_updates[-1]["status"] == "idle"


def test_codex_runtime_interrupt_no_active_sdk_turn_sets_idle() -> None:
    asyncio.run(_test_codex_runtime_interrupt_no_active_sdk_turn_sets_idle())


async def _test_codex_runtime_interrupt_no_active_sdk_turn_sets_idle() -> None:
    client = FakeCodexClient()
    client.results["turn/interrupt"] = RuntimeError(
        "Codex SDK has no active turn for thread thread_1"
    )
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    result = await runtime.interrupt_turn("sess_1", "thread_1")

    assert result.ok is False
    assert result.code == "turn_not_found"
    assert result.result["interrupted"] is False
    assert host.state_updates[-1]["status"] == "idle"


def test_codex_runtime_interrupt_no_active_sdk_turn_request_error_sets_idle() -> None:
    asyncio.run(_test_codex_runtime_interrupt_no_active_sdk_turn_request_error_sets_idle())


async def _test_codex_runtime_interrupt_no_active_sdk_turn_request_error_sets_idle() -> None:
    client = FakeCodexClient()
    client.results["turn/interrupt"] = RuntimeInvalidRequestError(
        "Codex SDK has no active turn for thread thread_1"
    )
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    result = await runtime.interrupt_turn("sess_1", "thread_1")

    assert result.ok is False
    assert result.code == "turn_not_found"
    assert result.result["interrupted"] is False
    assert host.state_updates[-1]["status"] == "idle"
    assert (
        host.state_updates[-1]["metadata"]["source"]
        == "codex.turn/interrupt.soft-failed"
    )


def test_codex_runtime_responds_to_approval_interaction() -> None:
    asyncio.run(_test_codex_runtime_responds_to_approval_interaction())


async def _test_codex_runtime_responds_to_approval_interaction() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)
    await runtime.start_turn("sess_1", "thread_1", "hello")

    result = await runtime.respond_interaction(
        "sess_1",
        "notice_1",
        "approve_for_session",
        {"approvalSource": {"requestId": "42"}},
    )

    assert result.ok is True
    assert result.result["decision"] == "acceptForSession"
    assert client.responses == [("42", {"decision": "acceptForSession"})]
    assert host.state_updates[-1]["status"] == "running"
    assert host.state_updates[-1]["metadata"]["notice_id"] == "notice_1"


def test_codex_runtime_approval_response_resolves_notice() -> None:
    asyncio.run(_test_codex_runtime_approval_response_resolves_notice())


async def _test_codex_runtime_approval_response_resolves_notice() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "jsonrpc": "2.0",
            "id": 42,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "item_cmd",
                "approvalId": "appr_cmd",
                "command": "ls -la",
            },
        }
    )
    result = await runtime.respond_interaction(
        "sess_1",
        "notice_approval_appr_cmd",
        "approve_for_session",
        {"approvalSource": {"requestId": 42}},
    )

    assert result.ok is True
    assert client.responses == [(42, {"decision": "acceptForSession"})]
    assert [notice.status for notice in host.notice_upserts] == [
        "open",
        "responding",
        "resolved",
    ]
    resolved = host.notice_upserts[-1]
    assert resolved.response_required is False
    assert resolved.blocking is None
    assert resolved.actions == ()
    assert resolved.context["approvalStatus"] == "resolved"
    assert resolved.context["decision"] == "acceptForSession"
    assert host.state_updates[-1]["status"] == "running"


def test_codex_runtime_failed_approval_response_keeps_notice_retryable() -> None:
    asyncio.run(_test_codex_runtime_failed_approval_response_keeps_notice_retryable())


async def _test_codex_runtime_failed_approval_response_keeps_notice_retryable() -> None:
    client = FakeCodexClient()
    client.response_error = RuntimeError("ipc disconnected")
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    await runtime._handle_notification(
        {
            "jsonrpc": "2.0",
            "id": 42,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "approvalId": "appr_cmd",
            },
        }
    )
    try:
        await runtime.respond_interaction(
            "sess_1",
            "notice_approval_appr_cmd",
            "approve",
            {"approvalSource": {"requestId": 42}},
        )
    except RuntimeError as exc:
        assert str(exc) == "ipc disconnected"
    else:
        raise AssertionError("respond_interaction should raise the SDK failure")

    assert [notice.status for notice in host.notice_upserts] == [
        "open",
        "responding",
        "open",
    ]
    retryable = host.notice_upserts[-1]
    assert retryable.response_required is True
    assert retryable.blocking == {"scope": "session", "targetId": "sess_1"}
    assert retryable.metadata["retryable"] is True
    assert retryable.metadata["error"] == {
        "code": "RuntimeError",
        "message": "ipc disconnected",
    }
    assert host.state_updates[-1]["status"] == "blocked"
    assert host.state_updates[-1]["metadata"]["notice_id"] == "notice_approval_appr_cmd"


def test_codex_runtime_terminal_turn_closes_open_approval_notice() -> None:
    asyncio.run(_test_codex_runtime_terminal_turn_closes_open_approval_notice())


async def _test_codex_runtime_terminal_turn_closes_open_approval_notice() -> None:
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())

    await runtime.start()
    await runtime._handle_notification(
        {
            "jsonrpc": "2.0",
            "id": 42,
            "method": "item/fileChange/requestApproval",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "approvalId": "appr_file",
            },
        }
    )
    await runtime._handle_notification(
        {
            "method": "turn/cancelled",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
            },
        }
    )

    assert [notice.status for notice in host.notice_upserts] == ["open", "closed"]
    closed = host.notice_upserts[-1]
    assert closed.notice_id == "notice_approval_appr_file"
    assert closed.response_required is False
    assert closed.blocking is None
    assert closed.actions == ()
    assert closed.metadata["close_reason"] == "cancelled"
    assert host.state_updates[-1]["status"] == "idle"


def test_codex_runtime_interrupt_closes_open_approval_notice() -> None:
    asyncio.run(_test_codex_runtime_interrupt_closes_open_approval_notice())


async def _test_codex_runtime_interrupt_closes_open_approval_notice() -> None:
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())

    await runtime.start_turn("sess_1", "thread_1", "hello")
    await runtime._handle_notification(
        {
            "jsonrpc": "2.0",
            "id": 42,
            "method": "item/commandExecution/requestApproval",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_new",
                "approvalId": "appr_cmd",
            },
        }
    )
    result = await runtime.interrupt_turn("sess_1", "thread_1")

    assert result.ok is True
    assert host.notice_upserts[-1].notice_id == "notice_approval_appr_cmd"
    assert host.notice_upserts[-1].status == "closed"
    assert host.notice_upserts[-1].metadata["close_reason"] == "interrupted"
    assert host.state_updates[-1]["status"] == "idle"


def test_codex_runtime_resolved_approval_keeps_blocked_with_other_open_notice() -> None:
    asyncio.run(
        _test_codex_runtime_resolved_approval_keeps_blocked_with_other_open_notice()
    )


async def _test_codex_runtime_resolved_approval_keeps_blocked_with_other_open_notice() -> (
    None
):
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start()
    for request_id, approval_id in ((42, "appr_one"), (43, "appr_two")):
        await runtime._handle_notification(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "item/commandExecution/requestApproval",
                "params": {
                    "platformSessionId": "sess_1",
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "approvalId": approval_id,
                },
            }
        )

    result = await runtime.respond_interaction(
        "sess_1",
        "notice_approval_appr_one",
        "approve",
        {"approvalSource": {"requestId": 42}},
    )

    assert result.ok is True
    assert host.notice_upserts[-1].notice_id == "notice_approval_appr_one"
    assert host.notice_upserts[-1].status == "resolved"
    assert host.state_updates[-1]["status"] == "blocked"
    assert host.state_updates[-1]["metadata"]["notice_id"] == "notice_approval_appr_one"


def test_codex_runtime_approval_response_after_turn_end_keeps_idle() -> None:
    asyncio.run(_test_codex_runtime_approval_response_after_turn_end_keeps_idle())


async def _test_codex_runtime_approval_response_after_turn_end_keeps_idle() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    await runtime._handle_notification(
        {
            "method": "turn/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_new",
            },
        }
    )
    result = await runtime.respond_interaction(
        "sess_1",
        "notice_ended",
        "approve",
        {"approvalSource": {"requestId": "42"}},
    )

    assert result.ok is True
    assert host.state_updates[-1]["status"] == "idle"
    assert host.state_updates[-1]["metadata"]["notice_id"] == "notice_ended"


def test_codex_catalog_helpers_ignore_unrecognized_items() -> None:
    models = model_catalog_from_codex_items([{}, {"id": "gpt"}], revision=3)
    permissions = permission_catalog_from_codex_items(
        [{}, {"id": "perm", "label": "Perm"}], revision=3
    )

    assert [model.id for model in models.models] == ["gpt"]
    assert [permission.id for permission in permissions.permissions] == ["perm"]


def _notification_method(message: Any) -> str:
    if isinstance(message, CodexSdkEvent):
        return message.event_type
    return str(message["method"])


def _config() -> RuntimeConfig:
    return RuntimeConfig(
        runtime="codex",
        revision=3,
        values={"environment": {}},
    )


class _FakeSdkClient:
    pass


class _FakeSdkTurn:
    async def stream(self):
        yield {
            "method": "item/agentMessage/delta",
            "params": {
                "itemId": "item_agent",
                "delta": "hello",
            },
        }


@dataclass
class _SdkThreadHandle:
    id: str
    _client: Any
