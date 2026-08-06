from __future__ import annotations

from collections.abc import Sequence
from enum import Enum

from openai_codex.generated.v2_all import (
    AgentMessageDeltaNotification,
    AgentMessageThreadItem,
    CollabAgentState,
    CollabAgentToolCallThreadItem,
    CommandExecutionOutputDeltaNotification,
    CommandExecutionThreadItem,
    ContentItem,
    ContextCompactionThreadItem,
    DynamicToolCallOutputContentItem,
    DynamicToolCallThreadItem,
    FileChangeOutputDeltaNotification,
    FileChangePatchUpdatedNotification,
    FileChangeThreadItem,
    FileUpdateChange,
    FunctionCallResponseItem,
    ImageUserInput,
    InputImageContentItem,
    InputImageDynamicToolCallOutputContentItem,
    InputTextContentItem,
    InputTextDynamicToolCallOutputContentItem,
    ItemCompletedNotification,
    ItemStartedNotification,
    LocalImageUserInput,
    McpToolCallThreadItem,
    MentionUserInput,
    MessageResponseItem,
    OutputTextContentItem,
    PlanDeltaNotification,
    PlanThreadItem,
    RawResponseItemCompletedNotification,
    ReasoningSummaryPartAddedNotification,
    ReasoningSummaryTextDeltaNotification,
    ReasoningTextDeltaNotification,
    ReasoningThreadItem,
    ResponseItem,
    SkillUserInput,
    TextUserInput,
    Thread,
    ThreadItem,
    TurnCompletedNotification,
    TurnStartedNotification,
    UserInput,
    UserMessageThreadItem,
    WebSearchThreadItem,
)

from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.timeline.projection import CodexTimelineProjection


def timeline_projection_from_sdk_event(
    event: CodexSdkEvent,
) -> CodexTimelineProjection | None:
    payload = event.payload
    if payload is None:
        return None
    if isinstance(payload, AgentMessageDeltaNotification):
        return CodexTimelineProjection(
            native_id=payload.item_id,
            raw_type="agentMessage",
            status="inProgress",
            role="assistant",
            turn_id=payload.turn_id,
            text=payload.delta,
        )
    if isinstance(payload, CommandExecutionOutputDeltaNotification):
        return CodexTimelineProjection(
            native_id=payload.item_id,
            raw_type="commandExecution",
            status="inProgress",
            turn_id=payload.turn_id,
            aggregated_output=payload.delta,
        )
    if isinstance(payload, FileChangeOutputDeltaNotification):
        return CodexTimelineProjection(
            native_id=payload.item_id,
            raw_type="fileChange",
            status="inProgress",
            turn_id=payload.turn_id,
            patch=payload.delta,
        )
    if isinstance(payload, FileChangePatchUpdatedNotification):
        return CodexTimelineProjection(
            native_id=payload.item_id,
            raw_type="fileChange",
            status="inProgress",
            turn_id=payload.turn_id,
            changes=tuple(file_update_change_mapping(change) for change in payload.changes),
        )
    if isinstance(
        payload,
        ReasoningTextDeltaNotification | ReasoningSummaryTextDeltaNotification,
    ):
        return CodexTimelineProjection(
            native_id=payload.item_id,
            raw_type="reasoning",
            status="inProgress",
            role="system",
            turn_id=payload.turn_id,
            text=payload.delta,
        )
    if isinstance(payload, PlanDeltaNotification):
        return CodexTimelineProjection(
            native_id=payload.item_id,
            raw_type="systemMessage",
            status="inProgress",
            role="system",
            turn_id=payload.turn_id,
            message=payload.delta,
        )
    if isinstance(payload, ReasoningSummaryPartAddedNotification):
        return CodexTimelineProjection(
            native_id=payload.item_id,
            raw_type="reasoning",
            status="inProgress",
            role="system",
            turn_id=payload.turn_id,
        )
    if isinstance(payload, ItemStartedNotification):
        return timeline_projection_from_thread_item(
            item=payload.item,
            turn_id=payload.turn_id,
            event_status="inProgress",
        )
    if isinstance(payload, ItemCompletedNotification):
        return timeline_projection_from_thread_item(
            item=payload.item,
            turn_id=payload.turn_id,
            event_status="completed",
        )
    if isinstance(payload, RawResponseItemCompletedNotification):
        return timeline_projection_from_response_item(
            item=payload.item,
            turn_id=payload.turn_id,
            event_status="completed",
        )
    return None


def timeline_projections_from_sdk_turn_event(
    event: CodexSdkEvent,
) -> tuple[CodexTimelineProjection, ...] | None:
    payload = event.payload
    if not isinstance(payload, TurnStartedNotification | TurnCompletedNotification):
        return None
    projections: list[CodexTimelineProjection] = []
    for item in payload.turn.items:
        projection = timeline_projection_from_thread_item(
            item=item,
            turn_id=payload.turn.id,
            event_status=None,
        )
        if projection is not None:
            projections.append(projection)
    return tuple(projections)


def timeline_projections_from_sdk_thread(
    thread: Thread,
    limit: int,
) -> tuple[CodexTimelineProjection, ...]:
    projections: list[CodexTimelineProjection] = []
    for turn in thread.turns:
        for item in turn.items:
            projection = timeline_projection_from_thread_item(
                item=item,
                turn_id=turn.id,
                event_status=None,
            )
            if projection is not None:
                projections.append(projection)
    return tuple(projections[:limit])


def sdk_event_delta_text(event: CodexSdkEvent) -> str | None:
    payload = event.payload
    if isinstance(
        payload,
        AgentMessageDeltaNotification
        | CommandExecutionOutputDeltaNotification
        | FileChangeOutputDeltaNotification
        | ReasoningTextDeltaNotification
        | ReasoningSummaryTextDeltaNotification
        | PlanDeltaNotification,
    ):
        return payload.delta
    return None


def timeline_projection_from_thread_item(
    item: ThreadItem,
    turn_id: str | None,
    event_status: str | None,
) -> CodexTimelineProjection | None:
    root = item.root
    if isinstance(root, AgentMessageThreadItem):
        return CodexTimelineProjection(
            native_id=root.id,
            raw_type="agentMessage",
            status=event_status,
            role="assistant",
            turn_id=turn_id,
            text=root.text,
        )
    if isinstance(root, UserMessageThreadItem):
        return CodexTimelineProjection(
            native_id=root.id,
            raw_type="userMessage",
            status=event_status,
            role="user",
            turn_id=turn_id,
            text=user_input_text(root.content),
            client_message_id=root.client_id,
        )
    if isinstance(root, ReasoningThreadItem):
        return CodexTimelineProjection(
            native_id=root.id,
            raw_type="reasoning",
            status=event_status,
            role="system",
            turn_id=turn_id,
            text=reasoning_text(root.content, root.summary),
        )
    if isinstance(root, CommandExecutionThreadItem):
        return CodexTimelineProjection(
            native_id=root.id,
            raw_type="commandExecution",
            status=enum_value(root.status) or event_status,
            role="tool",
            turn_id=turn_id,
            command=root.command,
            aggregated_output=root.aggregated_output,
            exit_code=root.exit_code,
        )
    if isinstance(root, McpToolCallThreadItem):
        return CodexTimelineProjection(
            native_id=root.id,
            raw_type="mcpToolCall",
            status=enum_value(root.status) or event_status,
            role="tool",
            turn_id=turn_id,
            server=root.server,
            name=root.tool,
            arguments=root.arguments,
            output=mcp_tool_call_result(root),
            message=mcp_tool_call_error_message(root),
        )
    if isinstance(root, DynamicToolCallThreadItem):
        return CodexTimelineProjection(
            native_id=root.id,
            raw_type="dynamicToolCall",
            status=enum_value(root.status) or event_status,
            role="tool",
            turn_id=turn_id,
            server=root.namespace,
            name=root.tool,
            arguments=root.arguments,
            output=dynamic_tool_call_output(root.content_items),
        )
    if isinstance(root, CollabAgentToolCallThreadItem):
        return CodexTimelineProjection(
            native_id=root.id,
            raw_type="collabAgentToolCall",
            status=enum_value(root.status) or event_status,
            role="tool",
            turn_id=turn_id,
            server="codex.collab",
            name=enum_value(root.tool) or "agent",
            arguments=collab_agent_tool_arguments(root),
            output=collab_agent_tool_output(root.agents_states),
        )
    if isinstance(root, WebSearchThreadItem):
        return CodexTimelineProjection(
            native_id=root.id,
            raw_type="webSearch",
            status=event_status,
            role="tool",
            turn_id=turn_id,
            message=root.query,
            arguments=web_search_action_value(root),
        )
    if isinstance(root, FileChangeThreadItem):
        return CodexTimelineProjection(
            native_id=root.id,
            raw_type="fileChange",
            status=enum_value(root.status) or event_status,
            turn_id=turn_id,
            changes=tuple(file_update_change_mapping(change) for change in root.changes),
        )
    if isinstance(root, PlanThreadItem):
        return CodexTimelineProjection(
            native_id=root.id,
            raw_type="systemMessage",
            status=event_status,
            role="system",
            turn_id=turn_id,
            message=root.text,
        )
    if isinstance(root, ContextCompactionThreadItem):
        return CodexTimelineProjection(
            native_id=root.id,
            raw_type="contextCompaction",
            status=event_status,
            role="system",
            turn_id=turn_id,
        )
    return CodexTimelineProjection(
        native_id=None,
        raw_type=root.__class__.__name__,
        status=event_status,
        turn_id=turn_id,
    )


def timeline_projection_from_response_item(
    item: ResponseItem,
    turn_id: str | None,
    event_status: str | None,
) -> CodexTimelineProjection | None:
    root = item.root
    if isinstance(root, MessageResponseItem):
        raw_type = "agentMessage" if root.role == "assistant" else "userMessage"
        return CodexTimelineProjection(
            native_id=root.id,
            raw_type=raw_type,
            status=event_status,
            role=root.role,
            turn_id=turn_id,
            text=content_items_text(root.content),
        )
    if isinstance(root, FunctionCallResponseItem):
        return CodexTimelineProjection(
            native_id=root.id or root.call_id,
            raw_type="function_call",
            status=event_status,
            role="tool",
            turn_id=turn_id,
            name=root.name,
            arguments=root.arguments,
        )
    return CodexTimelineProjection(
        native_id=None,
        raw_type=root.__class__.__name__,
        status=event_status,
        turn_id=turn_id,
    )


def file_update_change_mapping(change: FileUpdateChange) -> dict[str, str]:
    return {
        "kind": enum_value(change.kind) or "unknown",
        "path": change.path,
        "diff": change.diff,
    }


def mcp_tool_call_result(item: McpToolCallThreadItem) -> object | None:
    if item.result is None:
        return None
    if item.result.structured_content is not None:
        return item.result.structured_content
    return list(item.result.content)


def mcp_tool_call_error_message(item: McpToolCallThreadItem) -> str | None:
    if item.error is None:
        return None
    return item.error.message


def dynamic_tool_call_output(
    content_items: Sequence[DynamicToolCallOutputContentItem] | None,
) -> str | None:
    if content_items is None:
        return None
    parts: list[str] = []
    for item in content_items:
        root = item.root
        if isinstance(root, InputTextDynamicToolCallOutputContentItem):
            parts.append(root.text)
        elif isinstance(root, InputImageDynamicToolCallOutputContentItem):
            parts.append(root.image_url)
    return "\n".join(parts) if parts else None


def collab_agent_tool_arguments(item: CollabAgentToolCallThreadItem) -> dict[str, object]:
    return {
        "senderThreadId": item.sender_thread_id,
        "receiverThreadIds": list(item.receiver_thread_ids),
        "prompt": item.prompt,
        "model": item.model,
        "reasoningEffort": enum_value(item.reasoning_effort),
    }


def collab_agent_tool_output(states: dict[str, CollabAgentState]) -> dict[str, object]:
    return {
        agent_id: {
            "status": enum_value(state.status),
            "message": state.message,
        }
        for agent_id, state in states.items()
    }


def web_search_action_value(item: WebSearchThreadItem) -> object | None:
    if item.action is None:
        return None
    return item.action.root.type


def user_input_text(items: Sequence[UserInput]) -> str | None:
    parts: list[str] = []
    for item in items:
        root = item.root
        if isinstance(root, TextUserInput):
            parts.append(root.text)
        elif isinstance(root, ImageUserInput):
            parts.append(root.url)
        elif isinstance(root, LocalImageUserInput):
            parts.append(root.path)
        elif isinstance(root, SkillUserInput | MentionUserInput):
            parts.append(f"{root.name} {root.path}")
    return "\n".join(parts) if parts else None


def reasoning_text(
    content: Sequence[str] | None,
    summary: Sequence[str] | None,
) -> str | None:
    parts: list[str] = []
    if content is not None:
        parts.extend(content)
    if summary is not None:
        parts.extend(summary)
    return "\n".join(parts) if parts else None


def content_items_text(items: Sequence[ContentItem]) -> str | None:
    parts: list[str] = []
    for item in items:
        root = item.root
        if isinstance(root, InputTextContentItem | OutputTextContentItem):
            parts.append(root.text)
        elif isinstance(root, InputImageContentItem):
            parts.append(root.image_url)
    return "\n".join(parts) if parts else None


def enum_value(value: Enum | str | None) -> str | None:
    if isinstance(value, Enum):
        return str(value.value)
    if isinstance(value, str) and value:
        return value
    return None
