from __future__ import annotations

import asyncio
import threading
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import pytest
from openai_codex import InvalidRequestError
from openai_codex.generated.v2_all import (
    AgentMessageThreadItem,
    ApprovalsReviewer,
    AskForApprovalValue,
    ContextCompactedNotification,
    ContextCompactionThreadItem,
    LocalImageUserInput,
    MentionUserInput,
    TextUserInput,
    Thread,
    ThreadItem,
    Turn,
    TurnError,
    TurnStatus,
    UserInput,
    UserMessageThreadItem,
)
from openai_codex.models import (
    AgentMessageDeltaNotification,
    CommandExecutionOutputDeltaNotification,
    ItemCompletedNotification,
    Notification,
    ReasoningTextDeltaNotification,
    TurnCompletedNotification,
)

from connector.core.json_kv import JsonKeyValueStore
from connector.runtime_protocol import (
    CAPABILITY_CATALOG_MODEL,
    CAPABILITY_RUNTIME_ATTACHMENT,
    CAPABILITY_RUNTIME_CONFIG,
    CAPABILITY_SESSION_COMMANDS,
    CAPABILITY_SESSION_INTERRUPT,
    CAPABILITY_SESSION_SEND_MESSAGE,
    CAPABILITY_SESSION_STEER,
    ArtifactTimelineItem,
    CommandToolContent,
    CompactMarkerContent,
    MarkdownMessageContent,
    MarkerTimelineItem,
    MessageTimelineContent,
    MessageTimelineItem,
    RuntimeAttachment,
    RuntimeAttachmentContent,
    RuntimeCapabilitySet,
    RuntimeConfig,
    RuntimeInvalidRequestError,
    SessionSourceObservation,
    SessionNotice,
    SystemTimelineItem,
    TimelineSource,
    ToolTimelineItem,
    TurnEndTimelineItem,
    TurnStartTimelineItem,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain.catalogs import (
    model_catalog_from_codex_items,
    permission_catalog_from_codex_items,
)
from connector.runtimes.codex.domain.pending_messages import (
    CLIENT_MESSAGE_BINDINGS_VERSION,
    PendingClientMessageRegistry,
    client_message_bindings_key,
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
    CodexThreadTurnsResult,
    CodexTurnInputAttachment,
    CodexTurnResult,
)
from connector.runtimes.codex.sdk.shapes import notification_dict, thread_ref
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator
from connector.runtimes.codex.timeline.agent_calls import codex_agent_call_content
from connector.runtimes.codex.timeline.identity import (
    client_message_item_id,
    turn_position_item_id,
)
from connector.runtimes.codex.timeline.items import (
    CodexAgentMessageItem,
    CodexArtifactTimelineItem,
    CodexCollabAgentToolCallItem,
    CodexCommandExecutionItem,
    CodexContextCompactionItem,
    CodexDynamicToolCallItem,
    CodexFileChangeItem,
    CodexImageViewItem,
    CodexMarkerTimelineItem,
    CodexMcpToolCallItem,
    CodexMessageTimelineItem,
    CodexReasoningItem,
    CodexRuntimeMessageItem,
    CodexSubAgentActivityItem,
    CodexSystemTimelineItem,
    CodexTimelineItem,
    CodexToolTimelineItem,
    CodexTurnEndItem,
    CodexTurnEndTimelineItem,
    CodexTurnStartItem,
    CodexTurnStartTimelineItem,
    CodexUnknownItem,
    CodexUserMessageItem,
    CodexWebSearchItem,
    codex_timeline_item_class,
)
from connector.runtimes.codex.timeline.projection import (
    CodexTimelineProjection,
    timeline_item_from_projection,
    timeline_projection_from_raw,
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


def test_codex_unpositioned_user_message_uses_client_id_before_native_id() -> None:
    accumulator = CodexTimelineAccumulator()

    items = accumulator.items_from_snapshot_projections(
        session_id="sess_1",
        external_session_id="thread_1",
        projections=(
            CodexTimelineProjection(
                native_id="item_user_1",
                raw_type="userMessage",
                role="user",
                turn_id="turn_1",
                text="same prompt",
                client_message_id="cm_1",
            ),
            CodexTimelineProjection(
                native_id="item_user_2",
                raw_type="userMessage",
                role="user",
                turn_id="turn_1",
                text="same prompt",
                client_message_id="cm_2",
            ),
        ),
    )

    assert [item.id for item in items] == [
        client_message_item_id("thread_1", "cm_1"),
        client_message_item_id("thread_1", "cm_2"),
    ]
    assert [item.source["clientMessageId"] for item in items] == ["cm_1", "cm_2"]


def test_codex_client_message_id_rejects_colliding_native_alias() -> None:
    registry = PendingClientMessageRegistry("conn_test")
    registry.record_match(
        external_session_id="thread_1",
        native_item_id="item-1",
        client_message_id="cm_old",
        raw_type="userMessage",
        role="user",
        turn_id="turn_old",
        text="old prompt",
    )

    match = registry.attach_to_item(
        external_session_id="thread_1",
        native_item_id="item-1",
        client_message_id="cm_new",
        raw_type="userMessage",
        role="user",
        text="new prompt",
        turn_id="turn_new",
    )

    assert match is None


def test_codex_unbound_client_message_id_keeps_turn_identity_across_events() -> None:
    accumulator = CodexTimelineAccumulator(
        pending_messages=PendingClientMessageRegistry("conn_test")
    )
    accumulator.begin_turn("thread_1", "turn_1")
    params = {
        "threadId": "thread_1",
        "turnId": "turn_1",
        "item": {
            "id": "native_user_1",
            "type": "userMessage",
            "role": "user",
            "clientMessageId": "external_client_1",
            "text": "prompt",
        },
    }

    started = accumulator.item_from_notification(
        session_id="sess_1",
        external_session_id="thread_1",
        method="item/started",
        params={**params, "item": {**params["item"], "status": "inProgress"}},
    )
    completed = accumulator.item_from_notification(
        session_id="sess_1",
        external_session_id="thread_1",
        method="item/completed",
        params={**params, "item": {**params["item"], "status": "completed"}},
    )

    expected_id = turn_position_item_id("thread_1", "turn_1", 0, lane="user-message")
    assert started is not None
    assert completed is not None
    assert started.id == expected_id
    assert completed.id == expected_id


def test_codex_timeline_native_item_classes_are_explicitly_mapped() -> None:
    assert codex_timeline_item_class("agentMessage") is CodexAgentMessageItem
    assert codex_timeline_item_class("userMessage") is CodexUserMessageItem
    assert codex_timeline_item_class("reasoning") is CodexReasoningItem
    assert codex_timeline_item_class("runtimeMessage") is CodexRuntimeMessageItem
    assert codex_timeline_item_class("commandExecution") is CodexCommandExecutionItem
    assert (
        codex_timeline_item_class("collabAgentToolCall") is CodexCollabAgentToolCallItem
    )
    assert (
        codex_timeline_item_class("SubAgentActivityThreadItem")
        is CodexSubAgentActivityItem
    )
    assert codex_timeline_item_class("mcpToolCall") is CodexMcpToolCallItem
    assert codex_timeline_item_class("dynamicToolCall") is CodexDynamicToolCallItem
    assert codex_timeline_item_class("webSearch") is CodexWebSearchItem
    assert codex_timeline_item_class("contextCompaction") is CodexContextCompactionItem
    assert issubclass(CodexContextCompactionItem, MarkerTimelineItem)
    assert codex_timeline_item_class("ImageViewThreadItem") is CodexImageViewItem
    assert issubclass(CodexImageViewItem, MarkerTimelineItem)
    assert codex_timeline_item_class("fileChange") is CodexFileChangeItem
    assert codex_timeline_item_class("turnStart") is CodexTurnStartItem
    assert codex_timeline_item_class("turnEnd") is CodexTurnEndItem
    assert codex_timeline_item_class("futureNativeType") is CodexUnknownItem


def test_codex_timeline_items_extend_protocol_parent_classes() -> None:
    assert issubclass(CodexMessageTimelineItem, MessageTimelineItem)
    assert issubclass(CodexToolTimelineItem, ToolTimelineItem)
    assert issubclass(CodexArtifactTimelineItem, ArtifactTimelineItem)
    assert issubclass(CodexMarkerTimelineItem, MarkerTimelineItem)
    assert issubclass(CodexSystemTimelineItem, SystemTimelineItem)
    assert issubclass(CodexTurnStartTimelineItem, TurnStartTimelineItem)
    assert issubclass(CodexTurnEndTimelineItem, TurnEndTimelineItem)

    assert issubclass(CodexAgentMessageItem, CodexMessageTimelineItem)
    assert issubclass(CodexUserMessageItem, CodexMessageTimelineItem)
    assert issubclass(CodexCommandExecutionItem, CodexToolTimelineItem)
    assert issubclass(CodexMcpToolCallItem, CodexToolTimelineItem)
    assert issubclass(CodexWebSearchItem, CodexToolTimelineItem)
    assert issubclass(CodexFileChangeItem, CodexArtifactTimelineItem)
    assert issubclass(CodexContextCompactionItem, CodexMarkerTimelineItem)
    assert issubclass(CodexImageViewItem, CodexMarkerTimelineItem)
    assert issubclass(CodexReasoningItem, CodexSystemTimelineItem)
    assert issubclass(CodexUnknownItem, CodexSystemTimelineItem)
    assert issubclass(CodexTurnStartItem, CodexTurnStartTimelineItem)
    assert issubclass(CodexTurnEndItem, CodexTurnEndTimelineItem)


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
    assert isinstance(item.content, CompactMarkerContent)
    assert platform_item.type == "marker"
    assert platform_item.role == "system"
    assert platform_item.content == {
        "kind": "compact",
        "label": "对话已压缩",
        "text": "The session context was compacted.",
        "format": "markdown",
        "state": "completed",
    }
    assert platform_item.source["rawType"] == "contextCompaction"


def test_codex_projection_maps_image_view_to_marker_content() -> None:
    projection = CodexTimelineProjection(
        native_id="image_view_1",
        raw_type="ImageViewThreadItem",
        status="completed",
    )

    item = timeline_item_from_projection(
        projection=projection,
        external_session_id="thread_1",
        fallback_index=0,
        event="item/completed",
    )
    platform_item = item.to_platform_item(session_id="sess_1", order_seq=0)

    assert isinstance(item, CodexImageViewItem)
    assert item.type == "marker"
    assert platform_item.content == {
        "kind": "system",
        "label": "查看图片",
        "state": "completed",
    }
    assert platform_item.source["rawType"] == "ImageViewThreadItem"


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
                            {
                                "id": "low",
                                "description": "SDK low reasoning description",
                            },
                            {
                                "id": "high",
                                "description": "SDK high reasoning description",
                            },
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
            "thread/list/archived": {"threads": []},
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
        archived: bool | None = None,
    ) -> CodexThreadListResult:
        params: dict[str, Any] = {
            "limit": limit,
            "sortKey": "updated_at",
        }
        if cursor is not None:
            params["cursor"] = cursor
        if archived is not None:
            params["archived"] = archived
        result = self.record_request(
            "thread/list/archived" if archived else "thread/list",
            params,
        )
        threads = result["threads"]
        return CodexThreadListResult(
            threads=tuple(threads),
            next_cursor=result.get("nextCursor"),
        )

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
        if request.attachments:
            params["attachments"] = [
                {
                    "name": attachment.name,
                    "path": attachment.path,
                    "mediaType": attachment.media_type,
                    "byteSize": attachment.byte_size,
                }
                for attachment in request.attachments
            ]
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
                "input": [
                    {"type": "text", "text": request.content, "text_elements": []}
                ],
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
        self.source_updates: list[SessionSourceObservation] = []
        self.turn_ends: list[dict[str, Any]] = []
        self.lifecycle_events: list[str] = []
        self.timeline_syncs: list[dict[str, Any]] = []
        self.timeline_item_upserts: list[Any] = []
        self.notice_upserts: list[SessionNotice] = []
        self.runtime_capability_updates: list[RuntimeCapabilitySet] = []
        self.session_capability_updates: list[RuntimeCapabilitySet] = []
        self.sync_states: dict[str, dict[str, Any]] = {}
        self.attachments: dict[str, RuntimeAttachmentContent] = {}

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
        self.lifecycle_events.append(f"state:{status}")
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

    async def session_source_update(
        self,
        observation: SessionSourceObservation,
    ) -> None:
        self.source_updates.append(observation)

    async def session_turn_ended(
        self,
        session_id: str,
        runtime: str,
        external_session_id: str | None = None,
        turn_id: str | None = None,
        outcome: str = "completed",
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        self.lifecycle_events.append("turn_end")
        self.turn_ends.append(
            {
                "session_id": session_id,
                "runtime": runtime,
                "external_session_id": external_session_id,
                "turn_id": turn_id,
                "outcome": outcome,
                "metadata": dict(metadata or {}),
            }
        )

    async def timeline_sync(
        self,
        session_id: str,
        runtime: str,
        items: tuple[Any, ...],
        external_session_id: str | None = None,
        complete: bool = False,
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

    async def attachment_download(
        self,
        session_id: str,
        file_id: str,
    ) -> RuntimeAttachmentContent:
        _ = session_id
        return self.attachments[file_id]


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


def test_codex_sdk_event_normalizes_typed_failed_turn_completion() -> None:
    event = CodexSdkEvent.from_value(
        Notification(
            method="turn/completed",
            payload=TurnCompletedNotification(
                threadId="thread_1",
                turn=Turn(
                    id="turn_failed",
                    status=TurnStatus.failed,
                    items=[],
                    completedAt=None,
                    durationMs=None,
                    error=TurnError(
                        message="Exploded",
                        additionalDetails="details",
                        codexErrorInfo=None,
                    ),
                    itemsView=None,
                    startedAt=None,
                ),
            ),
        ),
    )

    assert event.event_type == "turn/failed"
    assert event.params["turn"]["error"]["message"] == "Exploded"


def test_codex_sdk_event_normalizes_typed_interrupted_turn_completion() -> None:
    event = CodexSdkEvent.from_value(
        Notification(
            method="turn/completed",
            payload=TurnCompletedNotification(
                threadId="thread_1",
                turn=Turn(
                    id="turn_interrupted",
                    status=TurnStatus.interrupted,
                    items=[],
                    completedAt=None,
                    durationMs=None,
                    error=None,
                    itemsView=None,
                    startedAt=None,
                ),
            ),
        ),
    )

    assert event.event_type == "turn/interrupted"


def test_codex_timeline_projects_context_compaction_item_event() -> None:
    event = CodexSdkEvent.from_value(
        Notification(
            method="item/completed",
            payload=ItemCompletedNotification(
                completedAtMs=1,
                threadId="thread_1",
                turnId="turn_done",
                item=ThreadItem(
                    root=ContextCompactionThreadItem(
                        id="compact_1",
                        type="contextCompaction",
                    )
                ),
            ),
        ),
    )
    accumulator = CodexTimelineAccumulator()
    platform_item = accumulator.item_from_event(
        session_id="sess_1",
        external_session_id="thread_1",
        event=event,
    )

    assert platform_item is not None
    assert platform_item.source["rawType"] == "contextCompaction"
    item = timeline_item_from_projection(
        projection=CodexTimelineProjection(
            native_id="compact_1",
            raw_type="contextCompaction",
            turn_id="turn_done",
        ),
        external_session_id="thread_1",
        fallback_index=0,
        event="item/completed",
    )
    assert isinstance(item, CodexContextCompactionItem)
    assert platform_item.content["kind"] == "compact"


def test_codex_runtime_thread_compacted_notification_upserts_timeline_item() -> None:
    asyncio.run(
        _test_codex_runtime_thread_compacted_notification_upserts_timeline_item()
    )


async def _test_codex_runtime_thread_compacted_notification_upserts_timeline_item() -> (
    None
):
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
    assert item.type == "marker"
    assert item.status == "done"
    assert item.turn_id == "turn_compact"
    assert item.content["kind"] == "compact"
    assert item.content["label"] == "对话已压缩"
    assert item.content["state"] == "completed"
    assert item.source["rawType"] == "contextCompaction"
    assert host.state_updates[-1]["status"] == "idle"
    assert host.state_updates[-1]["metadata"]["source"] == "codex.thread/compacted"


def test_codex_runtime_thread_compacted_keeps_active_turn_running() -> None:
    asyncio.run(_test_codex_runtime_thread_compacted_keeps_active_turn_running())


async def _test_codex_runtime_thread_compacted_keeps_active_turn_running() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime._handle_notification(
        Notification(
            method="thread/compacted",
            payload=ContextCompactedNotification(
                threadId="thread_1",
                turnId="turn_before_active",
            ),
        )
    )
    session_id = host.timeline_item_upserts[-1].session_id
    runtime._active_turn_ids[session_id] = "turn_active"
    state_update_count = len(host.state_updates)

    await runtime._handle_notification(
        Notification(
            method="thread/compacted",
            payload=ContextCompactedNotification(
                threadId="thread_1",
                turnId="turn_active",
            ),
        )
    )

    assert len(host.state_updates) == state_update_count
    assert runtime._active_turn_ids[session_id] == "turn_active"


def test_codex_compaction_snapshot_uses_item_level_identity() -> None:
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
    assert snapshot_items[0].id == "compact_1"
    assert snapshot_items[0].id != started.id
    assert snapshot_items[0].content["kind"] == "compact"
    assert snapshot_items[0].content["state"] == "completed"


def test_codex_compaction_snapshot_allows_multiple_compaction_items() -> None:
    accumulator = CodexTimelineAccumulator()

    snapshot_items = accumulator.items_from_snapshot_projections(
        session_id="sess_1",
        external_session_id="thread_1",
        projections=(
            CodexTimelineProjection(
                native_id="item-160",
                raw_type="contextCompaction",
                role="system",
                turn_id="turn_1",
            ),
            CodexTimelineProjection(
                native_id="item-259",
                raw_type="contextCompaction",
                role="system",
                turn_id="turn_2",
            ),
        ),
    )

    assert [item.id for item in snapshot_items] == ["item-160", "item-259"]
    assert [item.source["itemId"] for item in snapshot_items] == [
        "item-160",
        "item-259",
    ]


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
        turn_position_item_id("thread_1", "turn_after_compact", 0),
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
    assert item.id == turn_position_item_id(
        "thread_1",
        "turn_1",
        0,
        lane="tool:commandExecution",
    )
    assert item.source["itemId"] == "item_command"
    assert item.type == "tool"
    assert item.status == "running"
    assert item.content == {
        "kind": "command",
        "command": "",
        "output": "running tests",
        "format": "text",
    }


def test_codex_timeline_accumulates_typed_reasoning_delta() -> None:
    accumulator = CodexTimelineAccumulator()
    first_event = CodexSdkEvent.from_value(
        Notification(
            method="item/reasoning/textDelta",
            payload=ReasoningTextDeltaNotification(
                contentIndex=0,
                delta="thinking ",
                itemId="item_reasoning",
                threadId="thread_1",
                turnId="turn_1",
            ),
        ),
    )
    second_event = CodexSdkEvent.from_value(
        Notification(
            method="item/reasoning/textDelta",
            payload=ReasoningTextDeltaNotification(
                contentIndex=0,
                delta="now",
                itemId="item_reasoning",
                threadId="thread_1",
                turnId="turn_1",
            ),
        ),
    )

    first = accumulator.item_from_event(
        session_id="sess_1",
        external_session_id="thread_1",
        event=first_event,
    )
    second = accumulator.item_from_event(
        session_id="sess_1",
        external_session_id="thread_1",
        event=second_event,
    )

    assert first is not None
    assert second is not None
    assert first.id == turn_position_item_id(
        "thread_1",
        "turn_1",
        0,
        lane="reasoning",
    )
    assert second.id == first.id
    assert second.type == "system"
    assert second.status == "running"
    assert second.content == {
        "kind": "reasoning",
        "text": "thinking now",
        "format": "markdown",
    }


def test_codex_terminal_turn_does_not_project_timeline_items() -> None:
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
    accumulator = CodexTimelineAccumulator()

    item = accumulator.item_from_event(
        session_id="sess_1",
        external_session_id="thread_1",
        event=event,
    )

    assert item is None


def test_codex_timeline_uses_typed_sdk_user_client_id_for_identity() -> None:
    event = CodexSdkEvent.from_value(
        Notification(
            method="item/completed",
            payload=ItemCompletedNotification(
                completedAtMs=1,
                threadId="thread_1",
                turnId="turn_done",
                item=ThreadItem(
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
                ),
            ),
        ),
    )
    accumulator = CodexTimelineAccumulator()

    item = accumulator.item_from_event(
        session_id="sess_1",
        external_session_id="thread_1",
        event=event,
    )

    assert item is not None
    assert item.id == turn_position_item_id(
        "thread_1",
        "turn_done",
        0,
        lane="user-message",
    )
    assert item.source["itemId"] == "item_user"
    assert item.source["clientMessageId"] == "msg_client_1"


def test_codex_timeline_omits_attachment_inputs_from_user_message_text() -> None:
    event = CodexSdkEvent.from_value(
        Notification(
            method="item/completed",
            payload=ItemCompletedNotification(
                completedAtMs=1,
                threadId="thread_1",
                turnId="turn_done",
                item=ThreadItem(
                    root=UserMessageThreadItem(
                        id="item_user",
                        type="userMessage",
                        clientId="msg_client_1",
                        content=[
                            UserInput(
                                root=TextUserInput(
                                    type="text",
                                    text="这个图里有什么",
                                )
                            ),
                            UserInput(
                                root=LocalImageUserInput(
                                    type="localImage",
                                    path="/tmp/image.png",
                                )
                            ),
                            UserInput(
                                root=MentionUserInput(
                                    type="mention",
                                    name="image.png",
                                    path="/tmp/image.png",
                                )
                            ),
                            UserInput(
                                root=TextUserInput(
                                    type="text",
                                    text="Attached file: image.png at /tmp/image.png",
                                )
                            ),
                        ],
                    )
                ),
            ),
        ),
    )
    accumulator = CodexTimelineAccumulator()

    item = accumulator.item_from_event(
        session_id="sess_1",
        external_session_id="thread_1",
        event=event,
    )

    assert item is not None
    assert item.content["text"] == "这个图里有什么"
    assert item.content["attachments"] == [
        {
            "fileId": "image.png",
            "path": "/tmp/image.png",
            "name": "image.png",
            "mediaType": "image/*",
        }
    ]


def test_codex_raw_user_message_restores_attachment_card_without_injected_text() -> (
    None
):
    projection = timeline_projection_from_raw(
        {
            "id": "item_user",
            "type": "userMessage",
            "input": [
                {
                    "type": "text",
                    "text": "这是什么文件\n\n[Attached file: timeline.json (application/json, 8 bytes) at /tmp/file_abc-timeline.json]",
                },
            ],
        }
    )
    item = timeline_item_from_projection(
        projection=projection,
        external_session_id="thread_1",
        fallback_index=0,
        event="thread/read",
    ).to_platform_item(session_id="sess_1", order_seq=0)

    assert item.content == {
        "kind": "markdown",
        "text": "这是什么文件",
        "format": "markdown",
        "attachments": [
            {
                "fileId": "file_abc",
                "path": "/tmp/file_abc-timeline.json",
                "name": "timeline.json",
                "mediaType": "application/json",
                "size": 8,
            }
        ],
    }


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


def test_codex_runtime_model_catalog_includes_custom_models() -> None:
    asyncio.run(_test_codex_runtime_model_catalog_includes_custom_models())


async def _test_codex_runtime_model_catalog_includes_custom_models() -> None:
    runtime = CodexRuntime(
        config=RuntimeConfig(
            runtime="codex",
            revision=3,
            values={
                "environment": {},
                "customModels": [
                    {
                        "modelId": "gpt-local-test",
                        "displayName": "GPT Local Test",
                    }
                ],
            },
        ),
        host=FakeHost(),
        client=FakeCodexClient(),
    )

    catalog = await runtime.list_model_catalog(query="local")

    assert catalog.revision > runtime.config.revision
    assert [model.id for model in catalog.models] == ["gpt-local-test"]
    assert catalog.models[0].title == "GPT Local Test"
    assert catalog.models[0].selection_id is not None
    assert catalog.models[0].selection_id.startswith("sel_model_")
    assert catalog.models[0].metadata["custom"] is True


def test_codex_runtime_applies_custom_model_selection_to_turn_start() -> None:
    asyncio.run(_test_codex_runtime_applies_custom_model_selection_to_turn_start())


async def _test_codex_runtime_applies_custom_model_selection_to_turn_start() -> None:
    client = FakeCodexClient()
    runtime = CodexRuntime(
        config=RuntimeConfig(
            runtime="codex",
            revision=3,
            values={
                "environment": {},
                "customModels": [
                    {
                        "modelId": "gpt-local-test",
                        "displayName": "GPT Local Test",
                    }
                ],
            },
        ),
        host=FakeHost(),
        client=client,
    )
    model_selection = (
        (await runtime.list_model_catalog(query="local")).models[0].selection_id
    )

    result = await runtime.start_turn(
        "sess_1",
        "thread_1",
        "hello",
        selections={"model": model_selection},
    )

    assert result.ok is True
    assert client.requests[-1] == (
        "turn/start",
        {
            "threadId": "thread_1",
            "input": [{"type": "text", "text": "hello", "text_elements": []}],
            "model": "gpt-local-test",
        },
    )


def test_codex_runtime_applies_custom_model_effort_to_turn_start() -> None:
    asyncio.run(_test_codex_runtime_applies_custom_model_effort_to_turn_start())


async def _test_codex_runtime_applies_custom_model_effort_to_turn_start() -> None:
    client = FakeCodexClient()
    runtime = CodexRuntime(
        config=RuntimeConfig(
            runtime="codex",
            revision=3,
            values={
                "environment": {},
                "customModels": [
                    {
                        "modelId": "gpt-local-test",
                        "displayName": "GPT Local Test",
                        "efforts": [
                            {
                                "effortId": "high",
                                "displayName": "High",
                            }
                        ],
                    }
                ],
            },
        ),
        host=FakeHost(),
        client=client,
    )
    model = (await runtime.list_model_catalog(query="local")).models[0]

    result = await runtime.start_turn(
        "sess_1",
        "thread_1",
        "hello",
        selections={"model": model.reasoning_items[0].selection_id},
    )

    assert model.selection_id is None
    assert model.reasoning_items[0].id == "high"
    assert model.reasoning_items[0].title == "High"
    assert result.ok is True
    assert client.requests[-1] == (
        "turn/start",
        {
            "threadId": "thread_1",
            "input": [{"type": "text", "text": "hello", "text_elements": []}],
            "model": "gpt-local-test",
            "effort": "high",
        },
    )


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


def test_codex_runtime_reports_unavailable_runtime_capabilities_without_client() -> (
    None
):
    asyncio.run(
        _test_codex_runtime_reports_unavailable_runtime_capabilities_without_client()
    )


async def _test_codex_runtime_reports_unavailable_runtime_capabilities_without_client() -> (
    None
):
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=None)

    capability_set = await runtime.get_runtime_capabilities()
    capabilities = {
        capability.capability_id: capability
        for capability in capability_set.capabilities
    }

    assert capabilities[CAPABILITY_RUNTIME_CONFIG].available is True
    assert capabilities[CAPABILITY_RUNTIME_ATTACHMENT].available is False
    assert capabilities[CAPABILITY_RUNTIME_ATTACHMENT].unavailable_reason == (
        "codex_unavailable"
    )
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
    assert capabilities[CAPABILITY_SESSION_COMMANDS].supported is False
    assert capabilities[CAPABILITY_SESSION_COMMANDS].available is False
    assert capabilities[CAPABILITY_SESSION_COMMANDS].unavailable_reason == "unsupported"
    assert capabilities[CAPABILITY_RUNTIME_ATTACHMENT].available is True
    assert capabilities[CAPABILITY_SESSION_INTERRUPT].available is False
    assert capabilities[CAPABILITY_SESSION_INTERRUPT].unavailable_reason == (
        "no_active_turn"
    )
    assert capabilities[CAPABILITY_SESSION_STEER].available is False


def test_codex_runtime_reports_error_session_can_send_message() -> None:
    asyncio.run(_test_codex_runtime_reports_error_session_can_send_message())


async def _test_codex_runtime_reports_error_session_can_send_message() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())
    await runtime._session_states.update(
        session_id="sess_1",
        external_session_id="thread_1",
        status="error",
        error={"code": "turn_failed", "message": "boom"},
        metadata={"source": "test.turn.failed"},
    )

    capability_set = await runtime.get_session_capabilities("sess_1", "thread_1")
    capabilities = {
        capability.capability_id: capability
        for capability in capability_set.capabilities
    }

    assert capabilities[CAPABILITY_SESSION_SEND_MESSAGE].available is True
    assert capabilities[CAPABILITY_SESSION_SEND_MESSAGE].unavailable_reason is None
    assert capabilities[CAPABILITY_SESSION_INTERRUPT].available is False


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
    await runtime.interrupt_session("sess_1")
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
    assert "codex/session-sync/thread_1" not in host.sync_states
    assert host.sync_states["codex/session-sync/thread_archived"]["session_id"] == (
        stable_session_id("conn_test", "thread_archived")
    )


def test_codex_runtime_complete_inventory_reads_active_and_archived_threads() -> None:
    asyncio.run(
        _test_codex_runtime_complete_inventory_reads_active_and_archived_threads()
    )


async def _test_codex_runtime_complete_inventory_reads_active_and_archived_threads() -> (
    None
):
    client = FakeCodexClient()
    client.results["thread/list"] = {
        "threads": [{"id": "thread_active", "name": "Active"}]
    }
    client.results["thread/list/archived"] = {
        "threads": [{"id": "thread_archived", "name": "Archived"}]
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    sessions = await runtime.list_complete_session_inventory(page_size=25)

    by_external_id = {session.external_session_id: session for session in sessions}
    assert by_external_id["thread_active"].source_state is not None
    assert by_external_id["thread_active"].source_state.availability == "available"
    assert by_external_id["thread_archived"].source_state is not None
    assert by_external_id["thread_archived"].source_state.availability == "archived"
    assert (
        by_external_id["thread_archived"].metadata["sync"]["requires_timeline_sync"]
        is False
    )
    assert [
        request for request in client.requests if request[0].startswith("thread/list")
    ] == [
        ("thread/list", {"limit": 25, "sortKey": "updated_at", "archived": False}),
        (
            "thread/list/archived",
            {"limit": 25, "sortKey": "updated_at", "archived": True},
        ),
    ]


def test_codex_runtime_projects_thread_archive_events_to_source_state() -> None:
    asyncio.run(_test_codex_runtime_projects_thread_archive_events_to_source_state())


async def _test_codex_runtime_projects_thread_archive_events_to_source_state() -> None:
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())
    session_id = stable_session_id("conn_test", "thread_1")

    await runtime._handle_notification(
        {"method": "thread/archived", "params": {"threadId": "thread_1"}}
    )
    blocked = await runtime.start_turn(session_id, "thread_1", "hello")
    await runtime._handle_notification(
        {"method": "thread/unarchived", "params": {"threadId": "thread_1"}}
    )

    assert blocked.code == "session_archived"
    assert not any(request[0] == "turn/start" for request in runtime.client.requests)
    assert [item.state.availability for item in host.source_updates] == [
        "archived",
        "available",
    ]
    assert all(item.state.observation_origin == "event" for item in host.source_updates)


def test_codex_runtime_start_turn_returns_archived_source_error() -> None:
    asyncio.run(_test_codex_runtime_start_turn_returns_archived_source_error())


async def _test_codex_runtime_start_turn_returns_archived_source_error() -> None:
    client = FakeCodexClient()
    client.results["turn/start"] = InvalidRequestError(
        -32600,
        "session thread_1 is archived",
    )
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.start_turn(
        "sess_1",
        "thread_1",
        "hello",
        client_message_id="cm_1",
    )

    assert result.ok is False
    assert result.code == "session_archived"
    assert result.source_observation is not None
    assert result.source_observation.state.observation_origin == "operation"
    assert host.source_updates[-1].state.availability == "archived"
    assert (
        runtime._pending_messages.pending_message_by_client_id(
            "thread_1",
            "cm_1",
        )
        is None
    )


def test_codex_runtime_does_not_misclassify_ambiguous_active_thread_error() -> None:
    asyncio.run(
        _test_codex_runtime_does_not_misclassify_ambiguous_active_thread_error()
    )


async def _test_codex_runtime_does_not_misclassify_ambiguous_active_thread_error() -> (
    None
):
    client = FakeCodexClient()
    client.results["thread/list"] = {"threads": [{"id": "thread_1"}]}
    client.results["thread/list/archived"] = {"threads": []}
    client.results["turn/start"] = InvalidRequestError(
        -32600,
        "thread is owned by another app-server",
    )
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    with pytest.raises(InvalidRequestError):
        await runtime.start_turn("sess_1", "thread_1", "hello")

    assert host.source_updates == []


def test_codex_runtime_reconciles_ambiguous_archived_thread_error() -> None:
    asyncio.run(_test_codex_runtime_reconciles_ambiguous_archived_thread_error())


async def _test_codex_runtime_reconciles_ambiguous_archived_thread_error() -> None:
    client = FakeCodexClient()
    client.results["thread/list"] = {"threads": []}
    client.results["thread/list/archived"] = {"threads": [{"id": "thread_1"}]}
    client.results["turn/start"] = InvalidRequestError(
        -32600,
        "invalid thread state",
    )
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.start_turn("sess_1", "thread_1", "hello")

    assert result.code == "session_archived"
    assert host.source_updates[-1].state.availability == "archived"
    assert [request[0] for request in client.requests[-2:]] == [
        "thread/list",
        "thread/list/archived",
    ]


def test_codex_runtime_session_sync_marker_skips_unchanged_timeline() -> None:
    asyncio.run(_test_codex_runtime_session_sync_marker_skips_unchanged_timeline())


async def _test_codex_runtime_session_sync_marker_skips_unchanged_timeline() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    first = await runtime.list_sessions(limit=10)
    prepared = await runtime.prepare_session_timeline_sync(
        first[0].session_id,
        first[0].external_session_id,
    )
    assert prepared is not None
    assert prepared.commit is not None
    await prepared.commit()
    second = await runtime.list_sessions(limit=10)
    restarted_runtime = CodexRuntime(config=_config(), host=host, client=client)
    after_restart = await restarted_runtime.list_sessions(limit=10)

    assert first[0].metadata["sync"]["requires_timeline_sync"] is True
    assert second[0].metadata["sync"]["changed"] is False
    assert second[0].metadata["sync"]["requires_timeline_sync"] is False
    assert after_restart[0].session_id == first[0].session_id
    assert after_restart[0].metadata["sync"]["changed"] is False
    assert [request[0] for request in client.requests].count("thread/read") == 1


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

    first = await runtime.list_sessions(limit=10)
    prepared = await runtime.prepare_session_timeline_sync(
        first[0].session_id,
        first[0].external_session_id,
    )
    assert prepared is not None
    assert prepared.commit is not None
    await prepared.commit()
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
        {
            "limit": 5,
            "sortKey": "updated_at",
            "cursor": "next-page",
            "archived": False,
        },
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


def test_codex_runtime_resolves_live_session_state_by_external_session_id() -> None:
    asyncio.run(
        _test_codex_runtime_resolves_live_session_state_by_external_session_id()
    )


async def _test_codex_runtime_resolves_live_session_state_by_external_session_id() -> (
    None
):
    client = FakeCodexClient()
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)
    await runtime._session_states.update(
        session_id="sess_live",
        external_session_id="thread_1",
        status="running",
        metadata={"source": "codex.turn/started"},
    )

    state = await runtime.get_session_state(
        "sess_scanner",
        external_session_id="thread_1",
    )

    assert state is not None
    assert state.session_id == "sess_live"
    assert state.status == "running"
    assert state.metadata["source"] == "codex.turn/started"
    assert not any(method == "thread/read" for method, _params in client.requests)


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
    assert snapshot.complete is False
    assert [item.id for item in snapshot.items] == [
        turn_position_item_id("thread_1", "turn_1", 0, lane="user-message"),
        "item_assistant",
    ]
    assert snapshot.items[0].content_hash.startswith("sha256:")
    assert snapshot.items[0].role == "user"
    assert snapshot.items[0].turn_id == "turn_1"
    assert snapshot.items[0].content == {
        "kind": "markdown",
        "text": "hello",
        "format": "markdown",
    }
    assert snapshot.items[1].content == {
        "kind": "markdown",
        "text": "hi",
        "format": "markdown",
    }


def test_codex_runtime_reads_typed_sdk_snapshot_with_parent_turn_id() -> None:
    asyncio.run(_test_codex_runtime_reads_typed_sdk_snapshot_with_parent_turn_id())


def test_codex_runtime_reads_typed_sdk_snapshot_from_turn_pages() -> None:
    asyncio.run(_test_codex_runtime_reads_typed_sdk_snapshot_from_turn_pages())


async def _test_codex_runtime_reads_typed_sdk_snapshot_from_turn_pages() -> None:
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": Thread.model_validate(
            {
                "id": "thread_1",
                "cliVersion": "0.1.0",
                "createdAt": 1,
                "cwd": "/repo",
                "ephemeral": False,
                "modelProvider": "openai",
                "preview": "hello",
                "sessionId": "codex_session_1",
                "source": "appServer",
                "status": {"type": "notLoaded"},
                "turns": [],
                "updatedAt": 2,
            }
        )
    }

    async def list_thread_turns(thread_id: str) -> CodexThreadTurnsResult:
        assert thread_id == "thread_1"
        return CodexThreadTurnsResult(
            turns=(
                Turn.model_validate(
                    {
                        "id": "turn_paged",
                        "status": "completed",
                        "items": [
                            {
                                "id": "item_paged",
                                "type": "agentMessage",
                                "text": "from page",
                            }
                        ],
                    }
                ),
            )
        )

    client.list_thread_turns = list_thread_turns  # type: ignore[attr-defined]
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert [item.content["text"] for item in snapshot.items] == ["from page"]
    assert client.requests[-1] == (
        "thread/read",
        {"threadId": "thread_1", "includeTurns": False},
    )


async def _test_codex_runtime_reads_typed_sdk_snapshot_with_parent_turn_id() -> None:
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": Thread.model_validate(
            {
                "id": "thread_1",
                "cliVersion": "0.1.0",
                "createdAt": 1,
                "cwd": "/repo",
                "ephemeral": False,
                "modelProvider": "openai",
                "preview": "hello",
                "sessionId": "codex_session_1",
                "source": "appServer",
                "status": {"type": "notLoaded"},
                "turns": [
                    {
                        "id": "turn_sdk",
                        "status": "completed",
                        "items": [
                            {
                                "id": "item_user",
                                "type": "userMessage",
                                "content": [{"type": "text", "text": "hello"}],
                            },
                            {
                                "id": "item_assistant",
                                "type": "agentMessage",
                                "text": "hi",
                            },
                        ],
                    }
                ],
                "updatedAt": 2,
            }
        )
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert [item.id for item in snapshot.items] == [
        turn_position_item_id("thread_1", "turn_sdk", 0, lane="user-message"),
        turn_position_item_id("thread_1", "turn_sdk", 0),
    ]
    assert [item.turn_id for item in snapshot.items] == ["turn_sdk", "turn_sdk"]
    assert snapshot.items[0].source["itemId"] == "item_user"
    assert snapshot.items[1].source["itemId"] == "item_assistant"


def test_codex_runtime_typed_snapshot_preserves_messages_after_compaction() -> None:
    asyncio.run(
        _test_codex_runtime_typed_snapshot_preserves_messages_after_compaction()
    )


def test_codex_runtime_default_snapshot_reads_more_than_hundred_items() -> None:
    asyncio.run(_test_codex_runtime_default_snapshot_reads_more_than_hundred_items())


async def _test_codex_runtime_default_snapshot_reads_more_than_hundred_items() -> None:
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": Thread.model_validate(
            {
                "id": "thread_1",
                "cliVersion": "0.1.0",
                "createdAt": 1,
                "cwd": "/repo",
                "ephemeral": False,
                "modelProvider": "openai",
                "preview": "hello",
                "sessionId": "codex_session_1",
                "source": "appServer",
                "status": {"type": "notLoaded"},
                "turns": [
                    {
                        "id": "turn_many",
                        "status": "completed",
                        "items": [
                            {
                                "id": f"item_{index}",
                                "type": "agentMessage",
                                "text": f"message {index}",
                            }
                            for index in range(101)
                        ],
                    }
                ],
                "updatedAt": 2,
            }
        )
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert len(snapshot.items) == 101
    assert snapshot.items[0].id == turn_position_item_id("thread_1", "turn_many", 0)
    assert snapshot.items[-1].id == turn_position_item_id("thread_1", "turn_many", 100)
    assert snapshot.items[0].source["itemId"] == "item_0"
    assert snapshot.items[-1].source["itemId"] == "item_100"


async def _test_codex_runtime_typed_snapshot_preserves_messages_after_compaction() -> (
    None
):
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": Thread.model_validate(
            {
                "id": "thread_1",
                "cliVersion": "0.1.0",
                "createdAt": 1,
                "cwd": "/repo",
                "ephemeral": False,
                "modelProvider": "openai",
                "preview": "hello",
                "sessionId": "codex_session_1",
                "source": "appServer",
                "status": {"type": "notLoaded"},
                "turns": [
                    {
                        "id": "turn_compacted",
                        "status": "completed",
                        "items": [
                            {"id": "item_compact", "type": "contextCompaction"},
                            {
                                "id": "item_user",
                                "type": "userMessage",
                                "content": [{"type": "text", "text": "after compact"}],
                            },
                            {
                                "id": "item_assistant",
                                "type": "agentMessage",
                                "text": "visible answer",
                            },
                        ],
                    }
                ],
                "updatedAt": 2,
            }
        )
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert [item.id for item in snapshot.items] == [
        "item_compact",
        turn_position_item_id("thread_1", "turn_compacted", 0, lane="user-message"),
        turn_position_item_id("thread_1", "turn_compacted", 0),
    ]
    assert [item.turn_id for item in snapshot.items] == [
        "turn_compacted",
        "turn_compacted",
        "turn_compacted",
    ]


def test_codex_runtime_reads_typed_tool_items_from_snapshot() -> None:
    asyncio.run(_test_codex_runtime_reads_typed_tool_items_from_snapshot())


async def _test_codex_runtime_reads_typed_tool_items_from_snapshot() -> None:
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": Thread.model_validate(
            {
                "id": "thread_1",
                "cliVersion": "0.1.0",
                "createdAt": 1,
                "cwd": "/repo",
                "ephemeral": False,
                "modelProvider": "openai",
                "preview": "hello",
                "sessionId": "codex_session_1",
                "source": "appServer",
                "status": {"type": "notLoaded"},
                "turns": [
                    {
                        "id": "turn_tools",
                        "status": "completed",
                        "items": [
                            {
                                "id": "mcp_1",
                                "type": "mcpToolCall",
                                "server": "filesystem",
                                "tool": "read_file",
                                "arguments": {"path": "/repo/README.md"},
                                "status": "completed",
                                "result": {
                                    "content": [],
                                    "structuredContent": {"ok": True},
                                },
                            },
                            {
                                "id": "web_1",
                                "type": "webSearch",
                                "query": "Agents Anywhere",
                                "action": {"type": "search"},
                            },
                        ],
                    }
                ],
                "updatedAt": 2,
            }
        )
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert [item.id for item in snapshot.items] == [
        turn_position_item_id("thread_1", "turn_tools", 0, lane="tool:mcpToolCall"),
        turn_position_item_id("thread_1", "turn_tools", 0, lane="tool:webSearch"),
    ]
    assert [item.type for item in snapshot.items] == ["tool", "tool"]
    assert [item.turn_id for item in snapshot.items] == ["turn_tools", "turn_tools"]
    assert snapshot.items[0].source["itemId"] == "mcp_1"
    assert snapshot.items[0].source["rawType"] == "mcpToolCall"
    assert snapshot.items[0].content == {
        "kind": "mcp",
        "server": "filesystem",
        "tool": "read_file",
        "arguments": {"path": "/repo/README.md"},
        "output": {"ok": True},
        "error": None,
    }
    assert snapshot.items[1].source["itemId"] == "web_1"
    assert snapshot.items[1].source["rawType"] == "webSearch"
    assert snapshot.items[1].content == {
        "kind": "web_search",
        "query": "Agents Anywhere",
        "action": "search",
    }


def test_codex_runtime_reads_typed_dynamic_tool_item_from_snapshot() -> None:
    asyncio.run(_test_codex_runtime_reads_typed_dynamic_tool_item_from_snapshot())


async def _test_codex_runtime_reads_typed_dynamic_tool_item_from_snapshot() -> None:
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": Thread.model_validate(
            {
                "id": "thread_1",
                "cliVersion": "0.1.0",
                "createdAt": 1,
                "cwd": "/repo",
                "ephemeral": False,
                "modelProvider": "openai",
                "preview": "hello",
                "sessionId": "codex_session_1",
                "source": "appServer",
                "status": {"type": "notLoaded"},
                "turns": [
                    {
                        "id": "turn_dynamic",
                        "status": "completed",
                        "items": [
                            {
                                "id": "dyn_1",
                                "type": "dynamicToolCall",
                                "namespace": "browser",
                                "tool": "open",
                                "arguments": {"url": "https://example.com"},
                                "status": "completed",
                                "success": True,
                                "contentItems": [
                                    {"type": "inputText", "text": "opened"},
                                ],
                            },
                        ],
                    }
                ],
                "updatedAt": 2,
            }
        )
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert len(snapshot.items) == 1
    item = snapshot.items[0]
    assert item.id == turn_position_item_id(
        "thread_1", "turn_dynamic", 0, lane="tool:dynamicToolCall"
    )
    assert item.type == "tool"
    assert item.turn_id == "turn_dynamic"
    assert item.source["itemId"] == "dyn_1"
    assert item.source["rawType"] == "dynamicToolCall"
    assert item.content == {
        "kind": "mcp",
        "server": "browser",
        "tool": "open",
        "arguments": {"url": "https://example.com"},
        "output": "opened",
        "error": None,
    }


def test_codex_runtime_reads_typed_collab_agent_item_from_snapshot() -> None:
    asyncio.run(_test_codex_runtime_reads_typed_collab_agent_item_from_snapshot())


async def _test_codex_runtime_reads_typed_collab_agent_item_from_snapshot() -> None:
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": Thread.model_validate(
            {
                "id": "thread_1",
                "cliVersion": "0.1.0",
                "createdAt": 1,
                "cwd": "/repo",
                "ephemeral": False,
                "modelProvider": "openai",
                "preview": "hello",
                "sessionId": "codex_session_1",
                "source": "appServer",
                "status": {"type": "notLoaded"},
                "turns": [
                    {
                        "id": "turn_collab",
                        "status": "completed",
                        "items": [
                            {
                                "id": "collab_1",
                                "type": "collabAgentToolCall",
                                "tool": "spawnAgent",
                                "status": "completed",
                                "senderThreadId": "thread_1",
                                "receiverThreadIds": ["thread_2"],
                                "prompt": "inspect this",
                                "model": "gpt-example",
                                "agentsStates": {
                                    "agent_1": {
                                        "status": "completed",
                                        "message": "done",
                                    }
                                },
                            },
                        ],
                    }
                ],
                "updatedAt": 2,
            }
        )
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert len(snapshot.items) == 1
    item = snapshot.items[0]
    assert item.id == turn_position_item_id(
        "thread_1", "turn_collab", 0, lane="tool:collabAgentToolCall"
    )
    assert item.type == "tool"
    assert item.turn_id == "turn_collab"
    assert item.source["itemId"] == "collab_1"
    assert item.source["rawType"] == "collabAgentToolCall"
    assert item.content == {
        "kind": "agent_call",
        "title": "spawnAgent",
        "input": {
            "senderThreadId": "thread_1",
            "receiverThreadIds": ["thread_2"],
            "prompt": "inspect this",
            "model": "gpt-example",
            "reasoningEffort": None,
        },
        "output": {
            "agent_1": {
                "status": "completed",
                "message": "done",
            }
        },
        "nativeAction": "spawnAgent",
        "action": "spawn",
        "prompt": "inspect this",
        "agentId": "thread_2",
        "callerId": "thread_1",
        "targetIds": ["thread_2"],
        "model": "gpt-example",
        "agents": {
            "agent_1": {
                "status": "completed",
                "message": "done",
            }
        },
    }


def test_codex_runtime_reads_typed_subagent_activity_from_snapshot() -> None:
    asyncio.run(_test_codex_runtime_reads_typed_subagent_activity_from_snapshot())


async def _test_codex_runtime_reads_typed_subagent_activity_from_snapshot() -> None:
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": Thread.model_validate(
            {
                "id": "thread_1",
                "cliVersion": "0.1.0",
                "createdAt": 1,
                "cwd": "/repo",
                "ephemeral": False,
                "modelProvider": "openai",
                "preview": "hello",
                "sessionId": "codex_session_1",
                "source": "appServer",
                "status": {"type": "notLoaded"},
                "turns": [
                    {
                        "id": "turn_subagent",
                        "status": "completed",
                        "items": [
                            {
                                "id": "subagent_1",
                                "type": "subAgentActivity",
                                "agentPath": "/root/research_jingtian_sun",
                                "agentThreadId": "thread_2",
                                "kind": "started",
                            }
                        ],
                    }
                ],
                "updatedAt": 2,
            }
        )
    }
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    snapshot = await runtime.get_session_snapshot(
        "sess_1",
        external_session_id="thread_1",
    )

    assert len(snapshot.items) == 1
    item = snapshot.items[0]
    assert item.type == "tool"
    assert item.role == "tool"
    assert item.source["rawType"] == "SubAgentActivityThreadItem"
    assert item.content == {
        "kind": "agent_call",
        "title": "research_jingtian_sun",
        "input": {
            "receiverThreadIds": ["thread_2"],
            "description": "research_jingtian_sun",
            "agentPath": "/root/research_jingtian_sun",
        },
        "nativeAction": "spawnAgent",
        "action": "spawn",
        "description": "research_jingtian_sun",
        "agentId": "thread_2",
        "targetIds": ["thread_2"],
    }


@pytest.mark.parametrize(
    ("kind", "action"),
    [
        ("started", "spawn"),
        ("interacted", "send_input"),
        ("interrupted", "close"),
    ],
)
def test_codex_runtime_maps_subagent_activity_kinds(kind: str, action: str) -> None:
    projection = timeline_projection_from_raw(
        {
            "id": f"subagent_{kind}",
            "type": "subAgentActivity",
            "agentPath": "/root/research_agent",
            "agentThreadId": "thread_2",
            "kind": kind,
            "status": "completed",
        }
    )

    item = timeline_item_from_projection(
        projection,
        external_session_id="thread_1",
        fallback_index=0,
        event="thread/read",
    )
    platform_item = item.to_platform_item(session_id="sess_1", order_seq=1)

    assert platform_item.type == "tool"
    assert platform_item.content["kind"] == "agent_call"
    assert platform_item.content["action"] == action
    assert platform_item.content["description"] == "research_agent"


@pytest.mark.parametrize(
    ("native_action", "action"),
    [
        ("spawnAgent", "spawn"),
        ("sendInput", "send_input"),
        ("resumeAgent", "resume"),
        ("wait", "wait"),
        ("closeAgent", "close"),
    ],
)
def test_codex_runtime_maps_all_collab_agent_actions(
    native_action: str,
    action: str,
) -> None:
    content = codex_agent_call_content(
        native_action=native_action,
        arguments={
            "senderThreadId": "thread_1",
            "receiverThreadIds": ["thread_2"],
            "prompt": "continue",
            "model": "gpt-test",
            "reasoningEffort": "high",
        },
        output={"thread_2": {"status": "completed", "message": "done"}},
    ).to_mapping()

    assert content["kind"] == "agent_call"
    assert content["action"] == action
    assert content["nativeAction"] == native_action
    assert content["callerId"] == "thread_1"
    assert content["targetIds"] == ["thread_2"]
    assert content["agents"] == {"thread_2": {"status": "completed", "message": "done"}}


def test_codex_snapshot_keeps_assistant_native_identity_without_turn_id() -> None:
    asyncio.run(_test_codex_snapshot_keeps_assistant_native_identity_without_turn_id())


async def _test_codex_snapshot_keeps_assistant_native_identity_without_turn_id() -> (
    None
):
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

    assert host.timeline_item_upserts[-1].id == turn_position_item_id(
        "thread_1", "turn_1", 0
    )
    assert snapshot.items[0].id == "item-2"
    assert snapshot.items[0].source["itemId"] == "item-2"


def test_codex_turn_position_identity_matches_live_and_snapshot_native_ids() -> None:
    accumulator = CodexTimelineAccumulator()
    accumulator.begin_turn("thread_1", "turn_1")

    live_item = accumulator.item_from_notification(
        session_id="sess_1",
        external_session_id="thread_1",
        method="item/completed",
        params={
            "threadId": "thread_1",
            "turnId": "turn_1",
            "item": {
                "id": "msg_live",
                "type": "agentMessage",
                "status": "completed",
                "text": "same answer",
            },
        },
    )
    snapshot_items = accumulator.items_from_thread_snapshot(
        session_id="sess_1",
        external_session_id="thread_1",
        thread={
            "turns": [
                {
                    "id": "turn_1",
                    "items": [
                        {
                            "id": "item-1",
                            "type": "userMessage",
                            "status": "completed",
                            "text": "question",
                        },
                        {
                            "id": "item-2",
                            "type": "agentMessage",
                            "status": "completed",
                            "text": "same answer",
                        },
                    ],
                }
            ]
        },
        limit=None,
    )

    assert live_item is not None
    assert live_item.id == snapshot_items[1].id
    assert live_item.id.startswith("codex_item_")
    assert live_item.source["itemId"] == "msg_live"
    assert snapshot_items[1].source["itemId"] == "item-2"
    assert snapshot_items[0].id == turn_position_item_id(
        "thread_1", "turn_1", 0, lane="user-message"
    )


def test_codex_turn_position_identity_distinguishes_repeated_assistant_messages() -> (
    None
):
    accumulator = CodexTimelineAccumulator()
    accumulator.begin_turn("thread_1", "turn_1")

    live_items = tuple(
        accumulator.item_from_notification(
            session_id="sess_1",
            external_session_id="thread_1",
            method="item/completed",
            params={
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "id": native_id,
                    "type": "agentMessage",
                    "status": "completed",
                    "text": "same answer",
                },
            },
        )
        for native_id in ("msg_live_1", "msg_live_2")
    )
    snapshot_items = accumulator.items_from_thread_snapshot(
        session_id="sess_1",
        external_session_id="thread_1",
        thread={
            "turns": [
                {
                    "id": "turn_1",
                    "items": [
                        {
                            "id": "item-1",
                            "type": "userMessage",
                            "status": "completed",
                            "text": "question",
                        },
                        {
                            "id": "item-2",
                            "type": "agentMessage",
                            "status": "completed",
                            "text": "same answer",
                        },
                        {
                            "id": "item-3",
                            "type": "agentMessage",
                            "status": "completed",
                            "text": "same answer",
                        },
                    ],
                }
            ]
        },
        limit=None,
    )

    assert all(item is not None for item in live_items)
    live_ids = [item.id for item in live_items if item is not None]
    snapshot_assistant_ids = [
        item.id for item in snapshot_items if item.role == "assistant"
    ]
    assert live_ids == snapshot_assistant_ids
    assert len(set(live_ids)) == 2


def test_codex_turn_lane_identity_matches_normalized_history() -> None:
    accumulator = CodexTimelineAccumulator()
    accumulator.begin_turn("thread_1", "turn_1")
    live_raw_items = (
        {
            "id": "reasoning_1",
            "type": "reasoning",
            "status": "completed",
            "text": "plan",
        },
        {
            "id": "commentary_1",
            "type": "agentMessage",
            "status": "completed",
            "text": "working",
        },
        {
            "id": "tool_1",
            "type": "commandExecution",
            "status": "completed",
            "command": "pwd",
            "aggregatedOutput": "/repo",
        },
        {
            "id": "reasoning_2",
            "type": "reasoning",
            "status": "completed",
            "text": "check",
        },
        {
            "id": "reasoning_3",
            "type": "reasoning",
            "status": "completed",
            "text": "finish",
        },
        {
            "id": "final_1",
            "type": "agentMessage",
            "status": "completed",
            "text": "done",
        },
    )
    live_items = tuple(
        accumulator.item_from_notification(
            session_id="sess_1",
            external_session_id="thread_1",
            method="item/completed",
            params={
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": raw_item,
            },
        )
        for raw_item in live_raw_items
    )
    snapshot_items = accumulator.items_from_thread_snapshot(
        session_id="sess_scanner",
        external_session_id="thread_1",
        thread={
            "turns": [
                {
                    "id": "turn_1",
                    "items": [
                        {
                            "id": "item-1",
                            "type": "userMessage",
                            "status": "completed",
                            "text": "question",
                        },
                        {
                            "id": "item-2",
                            "type": "reasoning",
                            "status": "completed",
                            "text": "plan",
                        },
                        {
                            "id": "item-3",
                            "type": "agentMessage",
                            "status": "completed",
                            "text": "working",
                        },
                        {
                            "id": "item-4",
                            "type": "reasoning",
                            "status": "completed",
                            "text": "check\nfinish",
                        },
                        {
                            "id": "item-5",
                            "type": "agentMessage",
                            "status": "completed",
                            "text": "done",
                        },
                    ],
                }
            ]
        },
        limit=None,
    )

    assert all(item is not None for item in live_items)
    live_by_text = {
        item.content.get("text"): item
        for item in live_items
        if item is not None and item.type in {"message", "system"}
    }
    snapshot_by_text = {
        item.content.get("text"): item
        for item in snapshot_items
        if item.type in {"message", "system"}
    }
    assert live_by_text["working"].id == snapshot_by_text["working"].id
    assert live_by_text["done"].id == snapshot_by_text["done"].id
    assert live_by_text["plan"].id == snapshot_by_text["plan"].id
    assert live_by_text["check\nfinish"].id == snapshot_by_text["check\nfinish"].id
    assert live_by_text["done"].session_id == "sess_1"
    assert snapshot_by_text["done"].session_id == "sess_scanner"


def test_codex_turn_position_tracking_is_released_at_turn_end() -> None:
    accumulator = CodexTimelineAccumulator()
    accumulator.begin_turn("thread_1", "turn_1")
    item = accumulator.item_from_notification(
        session_id="sess_1",
        external_session_id="thread_1",
        method="item/completed",
        params={
            "threadId": "thread_1",
            "turnId": "turn_1",
            "item": {
                "id": "msg_live",
                "type": "agentMessage",
                "status": "completed",
                "text": "answer",
            },
        },
    )

    assert item is not None
    accumulator.end_turn("thread_1", "turn_1")
    accumulator.begin_turn("thread_1", "turn_1")
    restarted_item = accumulator.item_from_notification(
        session_id="sess_1",
        external_session_id="thread_1",
        method="item/completed",
        params={
            "threadId": "thread_1",
            "turnId": "turn_1",
            "item": {
                "id": "msg_after_restart",
                "type": "agentMessage",
                "status": "completed",
                "text": "answer",
            },
        },
    )

    assert restarted_item is not None
    assert restarted_item.id == item.id


def test_codex_snapshot_reuses_turn_identity_when_user_client_id_arrives_late() -> None:
    asyncio.run(
        _test_codex_snapshot_reuses_turn_identity_when_user_client_id_arrives_late()
    )


async def _test_codex_snapshot_reuses_turn_identity_when_user_client_id_arrives_late() -> (
    None
):
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
                    "turnId": "turn_1",
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

    expected_id = turn_position_item_id(
        "thread_1",
        "turn_1",
        0,
        lane="user-message",
    )
    assert host.timeline_item_upserts[-1].id == expected_id
    assert snapshot.items[0].id == expected_id
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
    assert snapshot.items[0].content == {
        "kind": "markdown",
        "text": "nested",
        "format": "markdown",
    }


def test_codex_runtime_returns_empty_snapshot_without_external_session() -> None:
    asyncio.run(_test_codex_runtime_returns_empty_snapshot_without_external_session())


async def _test_codex_runtime_returns_empty_snapshot_without_external_session() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    snapshot = await runtime.get_session_snapshot("sess_1")

    assert snapshot.items == ()
    assert snapshot.complete is False


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


def test_codex_runtime_materializes_attachments_for_turn_start() -> None:
    asyncio.run(_test_codex_runtime_materializes_attachments_for_turn_start())


async def _test_codex_runtime_materializes_attachments_for_turn_start() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    host.attachments["file_1"] = RuntimeAttachmentContent(
        file_id="file_1",
        name="note.txt",
        media_type="text/plain",
        content=b"hello",
    )
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.start_turn(
        "sess_1",
        "thread_1",
        "read this",
        attachments=(
            RuntimeAttachment(
                file_id="file_1",
                name="note.txt",
                media_type="text/plain",
            ),
        ),
    )

    assert result.ok is True
    method, params = next(
        request for request in reversed(client.requests) if request[0] == "turn/start"
    )
    assert method == "turn/start"
    attachment = params["attachments"][0]
    assert attachment["name"] == "note.txt"
    assert attachment["mediaType"] == "text/plain"
    assert attachment["path"].endswith("/sess_1/file_1-note.txt")
    assert attachment["byteSize"] == 5


def test_codex_runtime_materializes_create_and_start_attachments_from_host(
    tmp_path, monkeypatch
) -> None:
    asyncio.run(
        _test_codex_runtime_materializes_create_and_start_attachments_from_host(
            tmp_path,
            monkeypatch,
        )
    )


async def _test_codex_runtime_materializes_create_and_start_attachments_from_host(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("AGENT_CONNECTOR_ATTACHMENTS_ROOT", str(tmp_path))
    client = FakeCodexClient()
    host = FakeHost()
    host.attachments["file_inline"] = RuntimeAttachmentContent(
        file_id="file_inline",
        name="note.txt",
        media_type="text/plain",
        content=b"hello inline",
    )
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.create_and_start_session(
        session_id="sess_inline",
        content="read this",
        attachments=(
            RuntimeAttachment(
                file_id="file_inline",
                name="note.txt",
                media_type="text/plain",
            ),
        ),
    )

    assert result.ok is True
    method, params = next(
        request for request in reversed(client.requests) if request[0] == "turn/start"
    )
    assert method == "turn/start"
    attachment = params["attachments"][0]
    assert attachment["name"] == "note.txt"
    assert attachment["mediaType"] == "text/plain"
    assert Path(attachment["path"]).read_bytes() == b"hello inline"
    assert attachment["byteSize"] == 12


def test_codex_runtime_does_not_restore_running_after_fast_terminal_turn() -> None:
    asyncio.run(_test_codex_runtime_does_not_restore_running_after_fast_terminal_turn())


async def _test_codex_runtime_does_not_restore_running_after_fast_terminal_turn() -> (
    None
):
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
    interrupt = await runtime.interrupt_session("sess_1")
    assert interrupt.ok is True
    assert interrupt.result["alreadyStopped"] is True


def test_codex_runtime_terminal_event_without_platform_session_uses_cached_session() -> (
    None
):
    asyncio.run(
        _test_codex_runtime_terminal_event_without_platform_session_uses_cached_session()
    )


async def _test_codex_runtime_terminal_event_without_platform_session_uses_cached_session() -> (
    None
):
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


async def _test_codex_runtime_update_session_selections_allows_platform_only_session() -> (
    None
):
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


def test_codex_runtime_hides_commands_for_loaded_thread() -> None:
    asyncio.run(_test_codex_runtime_hides_commands_for_loaded_thread())


async def _test_codex_runtime_hides_commands_for_loaded_thread() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    commands = await runtime.list_commands(
        "sess_1",
        external_session_id="thread_1",
        query="comp",
    )

    assert commands == ()


def test_codex_runtime_hides_commands_without_thread() -> None:
    asyncio.run(_test_codex_runtime_hides_commands_without_thread())


async def _test_codex_runtime_hides_commands_without_thread() -> None:
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())

    commands = await runtime.list_commands("sess_1", query="compact")

    assert commands == ()


def test_codex_runtime_rejects_compact_command_without_sdk_request() -> None:
    asyncio.run(_test_codex_runtime_rejects_compact_command_without_sdk_request())


async def _test_codex_runtime_rejects_compact_command_without_sdk_request() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    result = await runtime.execute_command(
        "sess_1",
        "compact",
        external_session_id="thread_1",
        raw="/compact",
    )

    assert result.ok is False
    assert result.command == "compact"
    assert result.code == "unknown_command"
    assert result.message == "Codex runtime does not support /compact"
    assert all(request[0] != "thread/compact/start" for request in client.requests)
    assert host.notice_upserts == []
    assert host.timeline_item_upserts == []
    assert host.state_updates == []
    assert host.session_capability_updates == []


def test_codex_runtime_rejects_disabled_command_without_sdk_request() -> None:
    asyncio.run(_test_codex_runtime_rejects_disabled_command_without_sdk_request())


async def _test_codex_runtime_rejects_disabled_command_without_sdk_request() -> None:
    client = FakeCodexClient()
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    result = await runtime.execute_command("sess_1", "compact")

    assert result.ok is False
    assert result.command == "compact"
    assert result.code == "unknown_command"
    assert result.message == "Codex runtime does not support /compact"
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
    assert result.code == "unknown_command"
    assert result.message == "Codex runtime does not support /compact"
    assert all(request[0] != "thread/compact/start" for request in client.requests)


def capability_map(capabilities: RuntimeCapabilitySet) -> dict[str, Any]:
    return {
        capability.capability_id: capability for capability in capabilities.capabilities
    }


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
                "turnId": "turn_1",
            },
        }
    )

    assert host.turn_ends == [
        {
            "session_id": "sess_1",
            "runtime": "codex",
            "external_session_id": "thread_1",
            "turn_id": "turn_1",
            "outcome": "completed",
            "metadata": {"source": "codex.turn/completed"},
        }
    ]
    assert host.lifecycle_events[-2:] == ["turn_end", "state:idle"]
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
    result = await runtime.interrupt_session("sess_1")

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
    assert first.id == turn_position_item_id("thread_1", "turn_1", 0)
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

    assert host.timeline_item_upserts[-2].id == turn_position_item_id(
        "thread_1", "turn_1", 0
    )
    assert host.timeline_item_upserts[-1].id == turn_position_item_id(
        "thread_1", "turn_1", 1
    )
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


def test_codex_accumulator_merges_started_and_completed_agent_message_by_derived_key() -> (
    None
):
    accumulator = CodexTimelineAccumulator()
    started = accumulator.item_from_notification(
        session_id="sess_1",
        external_session_id="thread_1",
        method="item/started",
        params={
            "threadId": "thread_1",
            "turnId": "turn_1",
            "item": {
                "id": "msg_started",
                "type": "agentMessage",
                "_derivedKey": "agentMessage-assistant-turn_1-0",
                "status": "inProgress",
                "text": "",
            },
        },
    )
    completed = accumulator.item_from_notification(
        session_id="sess_1",
        external_session_id="thread_1",
        method="item/completed",
        params={
            "threadId": "thread_1",
            "turnId": "turn_1",
            "item": {
                "id": "msg_completed",
                "type": "agentMessage",
                "_derivedKey": "agentMessage-assistant-turn_1-0",
                "status": "completed",
                "text": "done",
            },
        },
    )

    assert started is not None
    assert completed is not None
    assert completed.id == started.id
    assert completed.status == "done"
    assert completed.content["text"] == "done"


def test_codex_accumulator_preserves_multiple_native_agent_messages() -> None:
    accumulator = CodexTimelineAccumulator()
    first = accumulator.item_from_notification(
        session_id="sess_1",
        external_session_id="thread_1",
        method="item/completed",
        params={
            "threadId": "thread_1",
            "turnId": "turn_1",
            "item": {
                "id": "msg_1",
                "type": "agentMessage",
                "status": "completed",
                "text": "first",
            },
        },
    )
    second = accumulator.item_from_notification(
        session_id="sess_1",
        external_session_id="thread_1",
        method="item/completed",
        params={
            "threadId": "thread_1",
            "turnId": "turn_1",
            "item": {
                "id": "msg_2",
                "type": "agentMessage",
                "status": "completed",
                "text": "second",
            },
        },
    )

    assert first is not None
    assert second is not None
    assert first.id == turn_position_item_id("thread_1", "turn_1", 0)
    assert second.id == turn_position_item_id("thread_1", "turn_1", 1)
    assert first.id != second.id
    assert first.content["text"] == "first"
    assert second.content["text"] == "second"


def test_codex_accumulator_preserves_repeated_user_message_text() -> None:
    accumulator = CodexTimelineAccumulator()
    first = accumulator.item_from_notification(
        session_id="sess_1",
        external_session_id="thread_1",
        method="item/completed",
        params={
            "threadId": "thread_1",
            "turnId": "turn_1",
            "item": {
                "id": "user_msg_1",
                "type": "userMessage",
                "status": "completed",
                "text": "你好",
            },
        },
    )
    second = accumulator.item_from_notification(
        session_id="sess_1",
        external_session_id="thread_1",
        method="item/completed",
        params={
            "threadId": "thread_1",
            "turnId": "turn_2",
            "item": {
                "id": "user_msg_2",
                "type": "userMessage",
                "status": "completed",
                "text": "你好",
            },
        },
    )

    assert first is not None
    assert second is not None
    assert first.id == turn_position_item_id(
        "thread_1", "turn_1", 0, lane="user-message"
    )
    assert second.id == turn_position_item_id(
        "thread_1", "turn_2", 0, lane="user-message"
    )
    assert first.id != second.id
    assert first.content["text"] == "你好"
    assert second.content["text"] == "你好"


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


def test_codex_runtime_completed_turn_only_finishes_lifecycle() -> None:
    asyncio.run(_test_codex_runtime_completed_turn_only_finishes_lifecycle())


async def _test_codex_runtime_completed_turn_only_finishes_lifecycle() -> None:
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

    assert host.timeline_syncs == []
    assert host.timeline_item_upserts == []
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
    assert [turn_end["outcome"] for turn_end in host.turn_ends] == [
        "interrupted",
        "cancelled",
    ]


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
    interrupt = await runtime.interrupt_session("sess_1")

    notice = host.notice_upserts[-1]
    assert notice.type == "interaction"
    assert notice.interaction_type == "execution_error"
    assert notice.severity == "error"
    assert notice.blocking == {"scope": "session", "targetId": "sess_1"}
    assert host.turn_ends[-1]["outcome"] == "failed"
    assert host.state_updates[-1]["status"] == "idle"
    assert interrupt.ok is True
    assert interrupt.result["alreadyStopped"] is True
    error_update = next(
        update for update in reversed(host.state_updates) if update["status"] == "error"
    )
    assert error_update["error"]["code"] == "boom"


def test_codex_runtime_native_failed_completion_sets_error_state() -> None:
    asyncio.run(_test_codex_runtime_native_failed_completion_sets_error_state())


async def _test_codex_runtime_native_failed_completion_sets_error_state() -> None:
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())

    await runtime.start_turn("sess_1", "thread_1", "hello")
    await runtime._handle_notification(
        {
            "method": "turn/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_new",
                "turn": {
                    "id": "turn_new",
                    "status": "failed",
                    "items": [],
                    "error": {
                        "code": "native_failure",
                        "message": "Native turn failed",
                    },
                },
            },
        }
    )

    error_update = next(
        update for update in reversed(host.state_updates) if update["status"] == "error"
    )
    assert error_update["error"]["code"] == "native_failure"
    assert error_update["error"]["message"] == "Native turn failed"


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
            "method": "item/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_new",
                "item": {
                    "id": "item_user",
                    "type": "userMessage",
                    "text": "hello from web",
                    "status": "completed",
                },
            },
        }
    )
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

    item = host.timeline_item_upserts[-1]
    assert item.id == client_message_item_id("thread_1", "cm_web_1")
    assert item.source["clientMessageId"] == "cm_web_1"
    assert item.source["derivedKey"] == "turn-item-v2-turn_new-user-message-0"
    assert host.timeline_syncs == []


def test_codex_runtime_remembers_completed_user_echo_client_message_id() -> None:
    asyncio.run(_test_codex_runtime_remembers_completed_user_echo_client_message_id())


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
        "method": "item/completed",
        "params": {
            "platformSessionId": "sess_1",
            "threadId": "thread_1",
            "turnId": "turn_new",
            "item": {
                "id": "item_user",
                "type": "userMessage",
                "text": "hello from web",
                "status": "completed",
            },
        },
    }

    await runtime._handle_notification(notification)
    await runtime._handle_notification(notification)

    first, second = host.timeline_item_upserts[-2:]
    assert first.id == client_message_item_id("thread_1", "cm_web_1")
    assert second.id == first.id
    assert first.source["clientMessageId"] == "cm_web_1"
    assert second.source["clientMessageId"] == "cm_web_1"
    assert host.timeline_syncs == []


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
                    "id": "item_live_user",
                    "type": "userMessage",
                    "text": "live hello",
                },
            },
        }
    )

    item = host.timeline_item_upserts[-1]
    assert item.id == client_message_item_id("thread_1", "cm_live_1")
    assert item.source["clientMessageId"] == "cm_live_1"
    assert item.role == "user"
    assert item.content == {
        "kind": "markdown",
        "text": "live hello",
        "format": "markdown",
    }


def test_codex_runtime_preserves_pending_user_attachments_after_codex_echo() -> None:
    asyncio.run(
        _test_codex_runtime_preserves_pending_user_attachments_after_codex_echo()
    )


async def _test_codex_runtime_preserves_pending_user_attachments_after_codex_echo() -> (
    None
):
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    host.attachments["file_1"] = RuntimeAttachmentContent(
        file_id="file_1",
        name="note.txt",
        media_type="text/plain",
        content=b"hello attachment",
    )
    await runtime.start_turn(
        "sess_1",
        "thread_1",
        "read this",
        attachments=(
            RuntimeAttachment(
                file_id="file_1",
                name="note.txt",
                media_type="text/plain",
                size=16,
            ),
        ),
        client_message_id="cm_file_1",
    )
    await runtime._handle_notification(
        {
            "method": "item/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_new",
                "item": {
                    "id": "item_user_file",
                    "type": "userMessage",
                    "text": "read this\n\nAttached file: note.txt\nPath: /tmp/note.txt\nFile content:\nhello attachment",
                    "status": "completed",
                },
            },
        }
    )

    item = host.timeline_item_upserts[-1]
    assert item.id == client_message_item_id("thread_1", "cm_file_1")
    assert item.source["clientMessageId"] == "cm_file_1"
    assert item.content == {
        "kind": "markdown",
        "text": "read this",
        "format": "markdown",
        "attachments": [
            {
                "fileId": "file_1",
                "name": "note.txt",
                "mediaType": "text/plain",
                "size": 16,
            }
        ],
    }


def test_codex_runtime_reconciles_snapshot_echo_after_restart_with_session_alias(
    tmp_path: Path,
) -> None:
    asyncio.run(
        _test_codex_runtime_reconciles_snapshot_echo_after_restart_with_session_alias(
            tmp_path
        )
    )


async def _test_codex_runtime_reconciles_snapshot_echo_after_restart_with_session_alias(
    tmp_path: Path,
) -> None:
    client = FakeCodexClient()
    host = FakeHost()
    kv_store = JsonKeyValueStore(tmp_path / "connector-kv.json")
    runtime = CodexRuntime(
        config=_config(),
        host=host,
        client=client,
        client_message_kv=kv_store,
    )

    host.attachments["file_1"] = RuntimeAttachmentContent(
        file_id="file_1",
        name="note.txt",
        media_type="text/plain",
        content=b"hello attachment",
    )
    await runtime.start_turn(
        "sess_1",
        "thread_1",
        "read this",
        attachments=(
            RuntimeAttachment(
                file_id="file_1",
                name="note.txt",
                media_type="text/plain",
                size=16,
            ),
        ),
        client_message_id="cm_file_1",
    )
    await runtime._handle_notification(
        {
            "method": "item/completed",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_new",
                "item": {
                    "id": "live_user_item",
                    "type": "userMessage",
                    "clientMessageId": "cm_file_1",
                    "text": "read this\n\nAttached file: note.txt\nPath: /tmp/note.txt\nFile content:\nhello attachment",
                    "status": "completed",
                },
            },
        }
    )

    restarted_host = FakeHost()
    restarted_client = FakeCodexClient()
    restarted_client.results["thread/read"] = {
        "thread": {
            "id": "thread_1",
            "items": [
                {
                    "id": "item-1",
                    "type": "userMessage",
                    "clientMessageId": "cm_file_1",
                    "text": "read this\n\n[Attached file: note.txt (text/plain, 16 bytes) at /tmp/file_1-note.txt]",
                    "status": "completed",
                },
            ],
        }
    }
    restarted_runtime = CodexRuntime(
        config=_config(),
        host=restarted_host,
        client=restarted_client,
        client_message_kv=kv_store,
    )

    snapshot = await restarted_runtime.get_session_snapshot(
        "sess_codex_alias",
        external_session_id="thread_1",
    )

    assert len(snapshot.items) == 1
    item = snapshot.items[0]
    assert item.id == client_message_item_id("thread_1", "cm_file_1")
    assert item.session_id == "sess_codex_alias"
    assert item.source["itemId"] == "item-1"
    assert item.source["clientMessageId"] == "cm_file_1"
    assert item.content == {
        "kind": "markdown",
        "text": "read this",
        "format": "markdown",
        "attachments": [
            {
                "fileId": "file_1",
                "name": "note.txt",
                "mediaType": "text/plain",
                "size": 16,
            }
        ],
    }


def test_codex_runtime_merges_v1_bindings_from_multiple_session_aliases(
    tmp_path: Path,
) -> None:
    asyncio.run(
        _test_codex_runtime_merges_v1_bindings_from_multiple_session_aliases(tmp_path)
    )


async def _test_codex_runtime_merges_v1_bindings_from_multiple_session_aliases(
    tmp_path: Path,
) -> None:
    kv_store = JsonKeyValueStore(tmp_path / "connector-kv.json")
    binding_key = client_message_bindings_key("conn_test", "thread_1")
    kv_store.set(
        binding_key,
        {
            "version": 1,
            "bindings": [
                {
                    "sessionId": "sess_live",
                    "externalSessionId": "thread_1",
                    "clientMessageId": "cm_file_1",
                    "platformItemId": "live_user_item",
                    "nativeItemIds": ["live_user_item"],
                    "derivedKeys": ["live-derived"],
                    "rawType": "userMessage",
                    "role": "user",
                    "turnId": "turn_1",
                    "text": "read this",
                    "attachments": [
                        {
                            "fileId": "file_1",
                            "name": "note.txt",
                            "mediaType": "text/plain",
                            "size": 16,
                        }
                    ],
                },
                {
                    "sessionId": "sess_codex_alias",
                    "externalSessionId": "thread_1",
                    "clientMessageId": "cm_file_1",
                    "platformItemId": "item-1",
                    "nativeItemIds": ["item-1"],
                    "derivedKeys": ["snapshot-derived"],
                    "rawType": "userMessage",
                    "role": "user",
                    "turnId": "turn_1",
                    "text": "read this",
                    "attachments": [],
                },
            ],
        },
    )
    client = FakeCodexClient()
    client.results["thread/read"] = {
        "thread": {
            "id": "thread_1",
            "items": [
                {
                    "id": "item-1",
                    "type": "userMessage",
                    "clientMessageId": "cm_file_1",
                    "text": "read this",
                    "status": "completed",
                }
            ],
        }
    }
    runtime = CodexRuntime(
        config=_config(),
        host=FakeHost(),
        client=client,
        client_message_kv=kv_store,
    )

    snapshot = await runtime.get_session_snapshot(
        "sess_codex_alias",
        external_session_id="thread_1",
    )

    assert len(snapshot.items) == 1
    item = snapshot.items[0]
    assert item.id == client_message_item_id("thread_1", "cm_file_1")
    assert item.content["attachments"] == [
        {
            "fileId": "file_1",
            "name": "note.txt",
            "mediaType": "text/plain",
            "size": 16,
        }
    ]
    migrated = kv_store.get(binding_key)
    assert migrated is not None
    assert migrated["version"] == CLIENT_MESSAGE_BINDINGS_VERSION
    assert len(migrated["bindings"]) == 1
    assert "sessionId" not in migrated["bindings"][0]
    assert "platformItemId" not in migrated["bindings"][0]


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
                    "id": "item_steer_user",
                    "type": "steeringUserMessage",
                    "text": "more context",
                },
            },
        }
    )

    item = host.timeline_item_upserts[-1]
    assert item.id == client_message_item_id("thread_1", "cm_steer_1")
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


def test_codex_sdk_stream_exhaustion_emits_failed_when_sdk_omits_terminal() -> None:
    asyncio.run(
        _test_codex_sdk_stream_exhaustion_emits_failed_when_sdk_omits_terminal()
    )


async def _test_codex_sdk_stream_exhaustion_emits_failed_when_sdk_omits_terminal() -> (
    None
):
    emitted: list[Any] = []
    client = CodexSdkClient(_FakeSdkClient())

    async def handler(message: Any) -> None:
        emitted.append(message)

    await client.start(handler)

    await client._stream_turn("thread_1", "turn_1", _FakeSdkTurn())

    assert [_notification_method(message) for message in emitted] == [
        "item/agentMessage/delta",
        "turn/failed",
    ]
    assert emitted[-1]["params"]["error"]["code"] == (
        "codex_stream_ended_without_terminal_event"
    )
    assert emitted[-1]["params"]["metadata"] == {"source": "codex.sdk.stream.exhausted"}


def test_codex_sdk_start_turn_initializes_before_low_level_detection() -> None:
    asyncio.run(_test_codex_sdk_start_turn_initializes_before_low_level_detection())


async def _test_codex_sdk_start_turn_initializes_before_low_level_detection() -> None:
    sdk_client = _LazyLowLevelSdkClient()
    client = CodexSdkClient(sdk_client, sdk=_SdkWithHandles())

    result = await client.start_turn(
        CodexStartTurnRequest(
            thread_id="thread_1",
            content="hello",
            approval_policy="on-request",
            approvals_reviewer="user",
            sandbox="workspace-write",
        )
    )

    assert sdk_client.initialized is True
    assert sdk_client.low_level.thread_resumes
    assert sdk_client.low_level.turn_starts
    assert not sdk_client.high_level_turns
    turn_params = sdk_client.low_level.turn_starts[0][2]
    assert turn_params.approval_policy.root == AskForApprovalValue.on_request
    assert turn_params.approvals_reviewer == ApprovalsReviewer.user
    assert turn_params.sandbox_policy.root.type == "workspaceWrite"
    assert result.turn_id == "turn_low"


def test_codex_sdk_start_thread_initializes_before_low_level_detection() -> None:
    asyncio.run(_test_codex_sdk_start_thread_initializes_before_low_level_detection())


def test_codex_sdk_start_turn_uses_low_level_for_attachments() -> None:
    asyncio.run(_test_codex_sdk_start_turn_uses_low_level_for_attachments())


async def _test_codex_sdk_start_turn_uses_low_level_for_attachments() -> None:
    sdk_client = _LazyLowLevelSdkClient()
    client = CodexSdkClient(sdk_client, sdk=_SdkWithHandles())

    result = await client.start_turn(
        CodexStartTurnRequest(
            thread_id="thread_1",
            content="inspect these",
            attachments=(
                CodexTurnInputAttachment(
                    name="image.png",
                    path="/tmp/image.png",
                    media_type="image/png",
                ),
                CodexTurnInputAttachment(
                    name="note.txt",
                    path="/tmp/note.txt",
                    media_type="text/plain",
                    byte_size=9,
                ),
            ),
        )
    )

    assert sdk_client.initialized is True
    assert sdk_client.low_level.turn_starts
    assert not sdk_client.high_level_turns
    _thread_id, wire_input, turn_params = sdk_client.low_level.turn_starts[0]
    assert result.turn_id == "turn_low"
    assert [item["type"] for item in wire_input] == [
        "text",
        "localImage",
    ]
    assert wire_input[0]["text"] == (
        "inspect these\n\n[Attached file: note.txt (text/plain, 9 bytes) at /tmp/note.txt]"
    )
    assert wire_input[1]["path"] == "/tmp/image.png"
    assert [item.root.type for item in turn_params.input] == [
        "text",
        "localImage",
    ]


async def _test_codex_sdk_start_thread_initializes_before_low_level_detection() -> None:
    sdk_client = _LazyLowLevelSdkClient()
    client = CodexSdkClient(sdk_client, sdk=_SdkWithHandles())

    result = await client.start_thread(
        CodexStartThreadRequest(
            cwd="/repo",
            approval_policy="on-request",
            approvals_reviewer="user",
            sandbox="workspace-write",
        )
    )

    assert sdk_client.initialized is True
    assert sdk_client.low_level.thread_starts
    assert not sdk_client.high_level_thread_starts
    thread_params = sdk_client.low_level.thread_starts[0]
    assert thread_params.approval_policy.root == AskForApprovalValue.on_request
    assert thread_params.approvals_reviewer == ApprovalsReviewer.user
    assert thread_params.sandbox.value == "workspace-write"
    assert result.thread_id == "thread_low"


def test_codex_sdk_approval_handler_waits_for_connector_response() -> None:
    asyncio.run(_test_codex_sdk_approval_handler_waits_for_connector_response())


async def _test_codex_sdk_approval_handler_waits_for_connector_response() -> None:
    sdk_client = _ApprovalBridgeSdkClient()
    client = CodexSdkClient(sdk_client)
    messages: list[Any] = []

    async def handler(message: Any) -> None:
        messages.append(message)

    await client.start(handler)

    task = asyncio.create_task(
        asyncio.to_thread(
            sdk_client.approval_handler,
            "item/commandExecution/requestApproval",
            {
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "item_cmd",
                "approvalId": "appr_cmd",
                "command": "touch /tmp/example",
            },
        )
    )
    while not messages:
        await asyncio.sleep(0)

    request_id = messages[0]["id"]
    assert request_id == "approval_appr_cmd"
    assert messages[0]["method"] == "item/commandExecution/requestApproval"
    await client.respond(request_id, {"decision": "accept"})

    assert await task == {"decision": "accept"}


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
    assert host.state_updates[-1]["status"] == "waiting_approval"
    assert host.state_updates[-1]["metadata"]["notice_id"] == "notice_approval_appr_cmd"
    assert [action["actionId"] for action in notice.actions] == [
        "approve",
        "approve_for_session",
        "reject",
    ]


def test_codex_runtime_permission_approval_uses_permission_response_shape() -> None:
    asyncio.run(
        _test_codex_runtime_permission_approval_uses_permission_response_shape()
    )


async def _test_codex_runtime_permission_approval_uses_permission_response_shape() -> (
    None
):
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    requested_permissions = {
        "fileSystem": {
            "write": ["/Users/t4wefan/code/github/Agents-Anywhere"],
        },
        "network": True,
    }
    await runtime.start()
    await runtime._handle_notification(
        {
            "jsonrpc": "2.0",
            "id": 43,
            "method": "item/permissions/requestApproval",
            "params": {
                "platformSessionId": "sess_1",
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "item_permissions",
                "approvalId": "appr_permissions",
                "reason": "Need workspace write and network access",
                "environmentId": "local",
                "cwd": "/Users/t4wefan/code/github/Agents-Anywhere",
                "permissions": requested_permissions,
            },
        }
    )

    notice = host.notice_upserts[-1]
    assert notice.notice_id == "notice_approval_appr_permissions"
    assert notice.message == "Need workspace write and network access"
    assert notice.context["kind"] == "permissions"
    assert notice.context["permissions"] == requested_permissions
    assert notice.context["environmentId"] == "local"
    assert [action["actionId"] for action in notice.actions] == [
        "approve",
        "approve_for_session",
        "reject",
    ]

    result = await runtime.respond_interaction(
        "sess_1",
        "notice_approval_appr_permissions",
        "approve_for_session",
        {"approvalSource": {"requestId": 43}},
    )

    assert result.ok is True
    assert result.result["decision"] == "session"
    assert client.responses == [
        (
            43,
            {
                "scope": "session",
                "permissions": requested_permissions,
            },
        )
    ]
    resolved = host.notice_upserts[-1]
    assert resolved.context["responsePayload"] == {
        "scope": "session",
        "permissions": requested_permissions,
    }


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
        host.state_updates[-1]["metadata"]["source"] == "codex.turn/steer.soft-failed"
    )


def test_codex_runtime_interrupts_active_turn_and_sets_idle() -> None:
    asyncio.run(_test_codex_runtime_interrupts_active_turn_and_sets_idle())


async def _test_codex_runtime_interrupts_active_turn_and_sets_idle() -> None:
    client = FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    result = await runtime.interrupt_session("sess_1")
    second = await runtime.interrupt_session("sess_1")

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
    assert second.ok is True
    assert second.result == {
        "interrupted": False,
        "alreadyStopped": True,
    }
    assert (
        host.state_updates[-1]["metadata"]["source"]
        == "codex.session/interrupt.already-stopped"
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
    result = await runtime.interrupt_session("sess_1")

    assert result.ok is True
    assert result.result["interrupted"] is False
    assert result.result["alreadyStopped"] is True
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
    result = await runtime.interrupt_session("sess_1")

    assert result.ok is True
    assert result.result["interrupted"] is False
    assert result.result["alreadyStopped"] is True
    assert host.state_updates[-1]["status"] == "idle"


def test_codex_runtime_interrupt_no_active_sdk_turn_request_error_sets_idle() -> None:
    asyncio.run(
        _test_codex_runtime_interrupt_no_active_sdk_turn_request_error_sets_idle()
    )


async def _test_codex_runtime_interrupt_no_active_sdk_turn_request_error_sets_idle() -> (
    None
):
    client = FakeCodexClient()
    client.results["turn/interrupt"] = RuntimeInvalidRequestError(
        "Codex SDK has no active turn for thread thread_1"
    )
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)

    await runtime.start_turn("sess_1", "thread_1", "hello")
    result = await runtime.interrupt_session("sess_1")

    assert result.ok is True
    assert result.result["interrupted"] is False
    assert result.result["alreadyStopped"] is True
    assert host.state_updates[-1]["status"] == "idle"
    assert (
        host.state_updates[-1]["metadata"]["source"]
        == "codex.session/interrupt.already-stopped"
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
        {
            "approvalStatus": "pending",
            "approvalSource": {"requestId": "42"},
        },
    )

    assert result.ok is True
    assert result.result["decision"] == "acceptForSession"
    assert client.responses == [("42", {"decision": "acceptForSession"})]
    assert host.state_updates[-1]["status"] == "running"
    assert host.state_updates[-1]["metadata"]["notice_id"] == "notice_1"


def test_codex_runtime_approval_response_ignores_pending_notice_status() -> None:
    asyncio.run(_test_codex_runtime_approval_response_ignores_pending_notice_status())


async def _test_codex_runtime_approval_response_ignores_pending_notice_status() -> None:
    client = FakeCodexClient()
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)

    result = await runtime.respond_interaction(
        "sess_1",
        "notice_1",
        "approve",
        {
            "approvalStatus": "pending",
            "approvalSource": {"requestId": "42"},
        },
    )

    assert result.ok is True
    assert result.result["decision"] == "accept"
    assert client.responses == [("42", {"decision": "accept"})]


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
    assert host.state_updates[-1]["status"] == "waiting_approval"
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
    result = await runtime.interrupt_session("sess_1")

    assert result.ok is True
    assert host.notice_upserts[-1].notice_id == "notice_approval_appr_cmd"
    assert host.notice_upserts[-1].status == "closed"
    assert host.notice_upserts[-1].metadata["close_reason"] == "interrupted"
    assert host.state_updates[-1]["status"] == "idle"


def test_codex_runtime_resolved_approval_keeps_waiting_approval_with_other_open_notice() -> (
    None
):
    asyncio.run(
        _test_codex_runtime_resolved_approval_keeps_waiting_approval_with_other_open_notice()
    )


async def _test_codex_runtime_resolved_approval_keeps_waiting_approval_with_other_open_notice() -> (
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
    assert host.state_updates[-1]["status"] == "waiting_approval"
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


class _ApprovalBridgeSdkClient:
    def __init__(self) -> None:
        self._client = _ApprovalBridgeAsyncClient()

    @property
    def approval_handler(self) -> Any:
        return self._client._sync._approval_handler


class _ApprovalBridgeAsyncClient:
    def __init__(self) -> None:
        self._sync = _ApprovalBridgeSyncClient()


class _ApprovalBridgeSyncClient:
    def __init__(self) -> None:
        self._approval_handler = None


class _LazyLowLevelSdkClient:
    def __init__(self) -> None:
        self._client: _FakeLowLevelCodexServer | None = None
        self.initialized = False
        self.high_level_thread_starts: list[dict[str, Any]] = []
        self.high_level_turns: list[dict[str, Any]] = []

    @property
    def low_level(self) -> _FakeLowLevelCodexServer:
        if self._client is None:
            raise AssertionError("low-level client was not initialized")
        return self._client

    async def _ensure_initialized(self) -> None:
        self.initialized = True
        self._client = _FakeLowLevelCodexServer()

    def thread_resume(self, thread_id: str, **kwargs: Any) -> _SdkThreadHandle:
        _ = kwargs
        return _SdkThreadHandle(thread_id, self)

    async def thread_start(self, **kwargs: Any) -> _SdkThreadHandle:
        self.high_level_thread_starts.append(dict(kwargs))
        return _SdkThreadHandle("thread_high", self)


class _FakeLowLevelCodexServer:
    def __init__(self) -> None:
        self.thread_starts: list[Any] = []
        self.thread_resumes: list[tuple[str, Any]] = []
        self.turn_starts: list[tuple[str, str, Any]] = []

    async def thread_start(self, params: Any) -> Any:
        self.thread_starts.append(params)
        return _SdkLowLevelThreadResult("thread_low")

    async def thread_resume(self, thread_id: str, params: Any) -> Any:
        self.thread_resumes.append((thread_id, params))
        return _SdkLowLevelThreadResult(thread_id)

    async def turn_start(self, thread_id: str, content: str, params: Any) -> Any:
        self.turn_starts.append((thread_id, content, params))
        return _SdkLowLevelTurnResult("turn_low")


@dataclass
class _SdkThreadHandle:
    id: str
    _client: Any


class _SdkWithHandles:
    AsyncThread = _SdkThreadHandle
    AsyncTurnHandle = None


@dataclass
class _SdkLowLevelThreadResult:
    thread_id: str

    @property
    def thread(self) -> Any:
        return _SdkId(self.thread_id)


@dataclass
class _SdkLowLevelTurnResult:
    turn_id: str

    @property
    def turn(self) -> Any:
        return _SdkId(self.turn_id)


@dataclass
class _SdkId:
    id: str
