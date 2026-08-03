from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Any

from openai_codex.generated.v2_all import (
    AgentMessageDeltaNotification,
    AgentMessageThreadItem,
    CommandExecutionOutputDeltaNotification,
    CommandExecutionThreadItem,
    ErrorNotification,
    FileChangeOutputDeltaNotification,
    FileChangePatchUpdatedNotification,
    FileChangeThreadItem,
    FunctionCallResponseItem,
    ItemCompletedNotification,
    ItemStartedNotification,
    MessageResponseItem,
    PlanDeltaNotification,
    PlanThreadItem,
    RawResponseItemCompletedNotification,
    ReasoningSummaryPartAddedNotification,
    ReasoningSummaryTextDeltaNotification,
    ReasoningTextDeltaNotification,
    ReasoningThreadItem,
    ThreadItem,
    Turn,
    TurnCompletedNotification,
    TurnStartedNotification,
    UserMessageThreadItem,
)
from openai_codex.models import Notification

DeltaNotificationPayload = (
    AgentMessageDeltaNotification
    | CommandExecutionOutputDeltaNotification
    | FileChangeOutputDeltaNotification
    | PlanDeltaNotification
    | ReasoningTextDeltaNotification
    | ReasoningSummaryTextDeltaNotification
)


@dataclass(frozen=True, slots=True)
class CodexSdkEvent:
    event_type: str
    thread_id: str | None
    platform_session_id: str | None
    turn_id: str | None
    item_id: str | None
    item_type: str | None
    role: str | None
    status: str | None
    content: Any
    raw: dict[str, Any]
    params: dict[str, Any]
    request_id: str | int | None = None
    legacy_method_shaped: bool = False

    @classmethod
    def from_value(
        cls,
        value: Any,
        thread_id: str | None = None,
        turn_id: str | None = None,
    ) -> CodexSdkEvent:
        sdk_event = sdk_notification_event(value, thread_id=thread_id, turn_id=turn_id)
        if sdk_event is not None:
            return cls.from_parts(
                event_type=sdk_event.event_type,
                params=sdk_event.params,
                raw=sdk_event.raw,
                request_id=None,
                legacy_method_shaped=False,
            )
        raw = sdk_event_mapping(value)
        method = raw.get("method")
        params = raw.get("params")
        if isinstance(method, str) and isinstance(params, dict):
            normalized_params = dict(params)
            if thread_id is not None:
                normalized_params.setdefault("threadId", thread_id)
            if turn_id is not None:
                normalized_params.setdefault("turnId", turn_id)
            return cls.from_parts(
                event_type=method,
                params=normalized_params,
                raw=raw,
                request_id=_request_id(raw),
                legacy_method_shaped=True,
            )
        event_type = (
            _first_string(raw, "type", "event", "kind") or value.__class__.__name__
        )
        normalized_params = dict(raw)
        if thread_id is not None:
            normalized_params.setdefault("threadId", thread_id)
        if turn_id is not None:
            normalized_params.setdefault("turnId", turn_id)
        return cls.from_parts(
            event_type=event_type,
            params=normalized_params,
            raw=raw,
            request_id=_request_id(raw),
            legacy_method_shaped=False,
        )

    @classmethod
    def from_message(cls, message: dict[str, Any]) -> CodexSdkEvent:
        return cls.from_value(message)

    @classmethod
    def from_parts(
        cls,
        event_type: str,
        params: dict[str, Any],
        raw: dict[str, Any],
        request_id: str | int | None = None,
        legacy_method_shaped: bool = False,
    ) -> CodexSdkEvent:
        item = params.get("item") if isinstance(params.get("item"), dict) else params
        item_dict = item if isinstance(item, dict) else {}
        thread_id = _first_string(params, "threadId", "thread_id", "conversationId")
        turn_id = _first_string(params, "turnId", "turn_id", "expectedTurnId")
        item_id = _first_string(
            item_dict,
            "id",
            "itemId",
            "item_id",
        ) or _first_string(params, "itemId", "item_id")
        item_type = _first_string(
            item_dict, "type", "kind", "itemType"
        ) or _first_string(params, "itemType", "item_type")
        role = _first_string(item_dict, "role") or _first_string(params, "role")
        status = _first_string(item_dict, "status") or _first_string(params, "status")
        content = (
            item_dict.get("content")
            if "content" in item_dict
            else params.get("content")
        )
        if content is None:
            content = _first_present(
                item_dict,
                "text",
                "message",
                "input",
                "delta",
                "outputDelta",
                "output_delta",
            )
        if content is None:
            content = _first_present(
                params,
                "text",
                "message",
                "input",
                "delta",
                "outputDelta",
                "output_delta",
            )
        return cls(
            event_type=event_type,
            thread_id=thread_id,
            platform_session_id=_first_string(
                params,
                "platformSessionId",
                "platform_session_id",
                "sessionId",
                "session_id",
            ),
            turn_id=turn_id,
            item_id=item_id,
            item_type=item_type,
            role=role,
            status=status,
            content=content,
            raw=raw,
            params=params,
            request_id=request_id,
            legacy_method_shaped=legacy_method_shaped,
        )

    @property
    def is_turn_started(self) -> bool:
        return self.event_type == "turn/started"

    @property
    def is_terminal_turn(self) -> bool:
        return self.event_type in {
            "turn/completed",
            "turn/interrupted",
            "turn/cancelled",
        }

    @property
    def is_failed_turn(self) -> bool:
        return self.event_type == "turn/failed"

    @property
    def is_running_item_event(self) -> bool:
        return self.event_type in {
            "item/started",
            "item/agentMessage/delta",
            "item/commandExecution/outputDelta",
        }

    def to_notification_dict(self) -> dict[str, Any]:
        return {
            "method": self.event_type,
            **({"id": self.request_id} if self.request_id is not None else {}),
            "params": dict(self.params),
        }


def sdk_event_mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        raw = dump(mode="json", by_alias=True, exclude_none=True)
        return dict(raw) if isinstance(raw, dict) else {}
    return {}


@dataclass(frozen=True, slots=True)
class _SdkNotificationProjection:
    event_type: str
    params: dict[str, Any]
    raw: dict[str, Any]


def sdk_notification_event(
    value: Any,
    thread_id: str | None = None,
    turn_id: str | None = None,
) -> _SdkNotificationProjection | None:
    """Project a known Codex SDK Notification by reading SDK attributes.

    The official SDK exposes `Notification(method, payload)` as a dataclass and
    generated Pydantic payload classes. Known payloads must be read through
    attributes here; downstream reducers should not start by dumping SDK models
    into generic dictionaries.
    """

    if not isinstance(value, Notification):
        return None
    params = _sdk_payload_params(value.method, value.payload)
    if params is None:
        return None
    if thread_id is not None:
        params.setdefault("threadId", thread_id)
    if turn_id is not None:
        params.setdefault("turnId", turn_id)
    return _SdkNotificationProjection(
        event_type=value.method,
        params=params,
        raw={
            "method": value.method,
            "payloadType": value.payload.__class__.__name__,
        },
    )


def _sdk_payload_params(method: str, payload: Any) -> dict[str, Any] | None:
    common = _sdk_common_params(payload)
    if isinstance(payload, DeltaNotificationPayload):
        return {
            **common,
            **_delta_item_semantics(payload),
            "delta": payload.delta,
            **(
                {"outputDelta": payload.delta}
                if isinstance(payload, CommandExecutionOutputDeltaNotification)
                else {}
            ),
        }
    if isinstance(payload, ReasoningSummaryPartAddedNotification):
        return common
    if isinstance(payload, FileChangePatchUpdatedNotification):
        return {
            **common,
            **_delta_item_semantics(payload),
            "changes": _sdk_sequence_value(payload.changes),
        }
    if isinstance(payload, ItemStartedNotification | ItemCompletedNotification):
        return {
            **common,
            "item": _sdk_thread_item(payload.item),
        }
    if isinstance(payload, TurnStartedNotification | TurnCompletedNotification):
        return {
            **common,
            "turn": _sdk_turn(payload.turn),
        }
    if isinstance(payload, ErrorNotification):
        return {
            **common,
            "error": _sdk_turn_error(payload.error),
            "willRetry": payload.will_retry,
        }
    if isinstance(payload, RawResponseItemCompletedNotification):
        return {
            **common,
            "item": _sdk_response_item(payload.item),
        }
    if method in {"turn/interrupted", "turn/cancelled"}:
        return common
    return common if common else None


def _delta_item_semantics(payload: Any) -> dict[str, Any]:
    if isinstance(payload, AgentMessageDeltaNotification):
        return {"itemType": "agentMessage", "role": "assistant", "status": "inProgress"}
    if isinstance(payload, CommandExecutionOutputDeltaNotification):
        return {"itemType": "commandExecution", "status": "inProgress"}
    if isinstance(
        payload,
        ReasoningTextDeltaNotification | ReasoningSummaryTextDeltaNotification,
    ):
        return {"itemType": "reasoning", "role": "system", "status": "inProgress"}
    if isinstance(
        payload,
        FileChangeOutputDeltaNotification | FileChangePatchUpdatedNotification,
    ):
        return {"itemType": "fileChange", "status": "inProgress"}
    if isinstance(payload, PlanDeltaNotification):
        return {"itemType": "systemMessage", "role": "system", "status": "inProgress"}
    return {}


def _sdk_common_params(payload: Any) -> dict[str, Any]:
    params: dict[str, Any] = {}
    thread_id = getattr(payload, "thread_id", None)
    if isinstance(thread_id, str) and thread_id:
        params["threadId"] = thread_id
    turn_id = getattr(payload, "turn_id", None)
    if isinstance(turn_id, str) and turn_id:
        params["turnId"] = turn_id
    item_id = getattr(payload, "item_id", None)
    if isinstance(item_id, str) and item_id:
        params["itemId"] = item_id
    return params


def _sdk_turn(turn: Turn) -> dict[str, Any]:
    return {
        "id": turn.id,
        "status": _enum_value(turn.status),
        "items": [_sdk_thread_item(item) for item in turn.items],
        **({"startedAt": turn.started_at} if isinstance(turn.started_at, int) else {}),
        **(
            {"completedAt": turn.completed_at}
            if isinstance(turn.completed_at, int)
            else {}
        ),
        **({"error": _sdk_turn_error(turn.error)} if turn.error is not None else {}),
    }


def _sdk_thread_item(item: ThreadItem) -> dict[str, Any]:
    root = item.root
    if isinstance(root, AgentMessageThreadItem):
        return {
            "id": root.id,
            "type": "agentMessage",
            "role": "assistant",
            "text": root.text,
            **({"phase": _enum_value(root.phase)} if root.phase is not None else {}),
        }
    if isinstance(root, UserMessageThreadItem):
        return {
            "id": root.id,
            "type": "userMessage",
            "input": [_sdk_user_input(part) for part in root.content],
            **({"clientId": root.client_id} if root.client_id else {}),
        }
    if isinstance(root, ReasoningThreadItem):
        return {
            "id": root.id,
            "type": "reasoning",
            "content": list(root.content or ()),
            "summaries": list(root.summary or ()),
        }
    if isinstance(root, CommandExecutionThreadItem):
        return {
            "id": root.id,
            "type": "commandExecution",
            "command": root.command,
            "status": _enum_value(root.status),
            "aggregatedOutput": root.aggregated_output,
            **({"exitCode": root.exit_code} if isinstance(root.exit_code, int) else {}),
            **({"cwd": str(root.cwd)} if root.cwd is not None else {}),
        }
    if isinstance(root, FileChangeThreadItem):
        return {
            "id": root.id,
            "type": "fileChange",
            "status": _enum_value(root.status),
            "changes": _sdk_sequence_value(root.changes),
        }
    if isinstance(root, PlanThreadItem):
        return {
            "id": root.id,
            "type": "systemMessage",
            "message": "Plan updated",
        }
    return {
        "id": _string_attr(root, "id"),
        "type": _string_attr(root, "type") or root.__class__.__name__,
    }


def _sdk_response_item(item: Any) -> dict[str, Any]:
    if isinstance(item, MessageResponseItem):
        return {
            "id": item.id,
            "type": "agentMessage" if item.role == "assistant" else "userMessage",
            "role": item.role,
            "text": _sdk_content_text(item.content),
        }
    if isinstance(item, FunctionCallResponseItem):
        return {
            "id": item.id or item.call_id,
            "type": "function_call",
            "name": item.name,
            "arguments": item.arguments,
        }
    return {
        "id": _string_attr(item, "id"),
        "type": _string_attr(item, "type") or item.__class__.__name__,
    }


def _sdk_user_input(value: Any) -> dict[str, Any]:
    root = getattr(value, "root", value)
    text = _string_attr(root, "text")
    if text is not None:
        return {"type": "text", "text": text}
    return {"type": _string_attr(root, "type") or root.__class__.__name__}


def _sdk_content_text(items: Sequence[Any]) -> str:
    parts: list[str] = []
    for item in items:
        root = getattr(item, "root", item)
        text = _string_attr(root, "text")
        if text:
            parts.append(text)
    return "\n".join(parts)


def _sdk_turn_error(error: Any) -> dict[str, Any]:
    return {
        "code": error.__class__.__name__ if error is not None else "codex_turn_failed",
        "message": _string_attr(error, "message") or "Codex turn failed.",
        **(
            {"additionalDetails": _string_attr(error, "additional_details")}
            if _string_attr(error, "additional_details")
            else {}
        ),
    }


def _sequence_attr(value: Any, name: str) -> Sequence[Any]:
    raw = getattr(value, name, ())
    return raw if isinstance(raw, Sequence) and not isinstance(raw, str | bytes) else ()


def _string_sequence_attr(value: Any, name: str) -> list[str]:
    return [item for item in _sequence_attr(value, name) if isinstance(item, str)]


def _sdk_sequence_value(value: Any) -> list[Any]:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes):
        return []
    result: list[Any] = []
    for item in value:
        if isinstance(item, str | int | float | bool) or item is None:
            result.append(item)
        else:
            result.append(str(item))
    return result


def _string_attr(value: Any, name: str) -> str | None:
    raw = getattr(value, name, None)
    return raw if isinstance(raw, str) and raw else None


def _enum_value(value: Any) -> str | None:
    if isinstance(value, Enum):
        return str(value.value)
    if isinstance(value, str):
        return value
    raw = getattr(value, "type", None)
    if isinstance(raw, str):
        return raw
    root = getattr(value, "root", None)
    if root is not None:
        return _enum_value(root)
    return None


def _first_string(mapping: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _first_present(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return None


def _request_id(raw: dict[str, Any]) -> str | int | None:
    value = raw.get("id") or raw.get("requestId") or raw.get("request_id")
    return value if isinstance(value, str | int) else None
