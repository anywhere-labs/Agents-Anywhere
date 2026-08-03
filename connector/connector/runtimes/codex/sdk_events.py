from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class CodexSdkEvent:
    event_type: str
    thread_id: str | None
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
        event_type = _first_string(raw, "type", "event", "kind") or value.__class__.__name__
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
        item_type = _first_string(item_dict, "type", "kind", "itemType") or _first_string(
            params, "itemType", "item_type"
        )
        role = _first_string(item_dict, "role") or _first_string(params, "role")
        status = _first_string(item_dict, "status") or _first_string(params, "status")
        content = item_dict.get("content") if "content" in item_dict else params.get("content")
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
