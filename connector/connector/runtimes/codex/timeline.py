from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeTimelineItem
from connector.runtimes.codex.sessions import (
    first_string_from_mapping,
    turn_id_from_result,
)


def timeline_items_from_thread(
    session_id: str,
    external_session_id: str,
    thread: dict[str, Any],
    limit: int,
) -> tuple[RuntimeTimelineItem, ...]:
    raw_items = raw_timeline_items(thread)
    items: list[RuntimeTimelineItem] = []
    for index, raw in enumerate(raw_items[:limit]):
        item_id = timeline_item_id(raw, external_session_id, index)
        content = timeline_item_content(raw)
        source = {
            "runtime": "codex",
            "event": "thread/read",
            "threadId": external_session_id,
            "rawType": raw.get("type"),
        }
        item_type = timeline_item_type(raw)
        status = timeline_item_status(raw)
        role = timeline_item_role(raw)
        items.append(
            RuntimeTimelineItem(
                id=item_id,
                session_id=session_id,
                type=item_type,
                status=status,
                order_seq=index,
                content_hash=content_hash(
                    {
                        "type": item_type,
                        "status": status,
                        "role": role,
                        "content": content,
                    }
                ),
                role=role,
                turn_id=timeline_item_turn_id(raw),
                content=content,
                source=source,
                revision=timeline_item_revision(raw),
                metadata={"raw": raw},
            )
        )
    return tuple(items)


def raw_timeline_items(thread: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("items", "timeline", "timelineItems", "timeline_items"):
        value = thread.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    turns = thread.get("turns")
    if isinstance(turns, list):
        result: list[dict[str, Any]] = []
        for turn in turns:
            if not isinstance(turn, dict):
                continue
            for key in ("items", "timeline", "timelineItems", "messages"):
                value = turn.get(key)
                if isinstance(value, list):
                    result.extend(item for item in value if isinstance(item, dict))
        return result
    messages = thread.get("messages")
    if isinstance(messages, list):
        return [item for item in messages if isinstance(item, dict)]
    return []


def timeline_item_id(raw: dict[str, Any], external_session_id: str, index: int) -> str:
    for key in ("id", "itemId", "item_id"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return f"codex_{external_session_id}_{index}_{content_hash(raw)[:16]}"


def timeline_item_type(raw: dict[str, Any]) -> str:
    value = raw.get("type") or raw.get("kind")
    if not isinstance(value, str) or not value:
        return "message"
    if value in {"agentMessage", "userMessage", "steeringUserMessage"}:
        return "message"
    if value == "reasoning":
        return "system"
    if value == "commandExecution":
        return "tool"
    if value == "fileChange":
        return "artifact"
    return value


def timeline_item_status(raw: dict[str, Any]) -> str:
    value = raw.get("status")
    if not isinstance(value, str) or not value:
        return "done"
    if value in {"inProgress", "in_progress"}:
        return "running"
    if value == "completed":
        return "done"
    return value


def timeline_item_role(raw: dict[str, Any]) -> str | None:
    value = raw.get("role")
    if isinstance(value, str) and value:
        return value
    item_type = raw.get("type")
    if item_type == "reasoning":
        return "system"
    if item_type in {"userMessage", "steeringUserMessage"}:
        return "user"
    if item_type == "agentMessage":
        return "assistant"
    if item_type == "commandExecution":
        return "tool"
    return None


def timeline_item_turn_id(raw: dict[str, Any]) -> str | None:
    for key in ("turnId", "turn_id"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def timeline_item_revision(raw: dict[str, Any]) -> int:
    value = raw.get("revision")
    return value if isinstance(value, int) and value > 0 else 1


def timeline_item_content(raw: dict[str, Any]) -> Mapping[str, Any]:
    content = raw.get("content")
    if raw.get("type") == "reasoning":
        if isinstance(content, dict):
            return {"kind": "reasoning", **content}
        text = raw.get("text")
        if isinstance(text, str):
            return {"kind": "reasoning", "text": text, "format": "markdown"}
        summary = raw.get("summary")
        if isinstance(summary, str):
            return {"kind": "reasoning", "text": summary, "format": "markdown"}
        summaries = raw.get("summaries")
        if isinstance(summaries, list):
            return {"kind": "reasoning", "summaries": summaries}
        return {"kind": "reasoning"}
    if isinstance(content, dict):
        return content
    text = raw.get("text")
    if isinstance(text, str):
        return {"text": text, "format": "markdown"}
    if isinstance(content, str):
        return {"text": content, "format": "markdown"}
    aggregated_output = raw.get("aggregatedOutput")
    if isinstance(aggregated_output, str):
        return {
            "command": raw.get("command") or raw.get("cmd") or "",
            "output": aggregated_output,
            "format": "text",
        }
    if raw.get("type") == "commandExecution":
        return {
            "command": raw.get("command") or raw.get("cmd") or "",
            "output": raw.get("output") or raw.get("outputText") or "",
            "format": "text",
        }
    return {}


def raw_item_from_notification(
    method: str,
    params: Mapping[str, Any],
) -> dict[str, Any] | None:
    if method not in {
        "item/started",
        "item/completed",
        "item/agentMessage/delta",
        "item/commandExecution/outputDelta",
    }:
        return None
    item = params.get("item")
    raw: dict[str, Any] = copy.deepcopy(item) if isinstance(item, dict) else {}
    item_id = first_string_from_mapping(params, "itemId", "item_id")
    if item_id is not None:
        raw["id"] = item_id
    if not isinstance(raw.get("id"), str) or not raw["id"]:
        return None
    if not isinstance(raw.get("type"), str) or not raw["type"]:
        if method == "item/agentMessage/delta":
            raw["type"] = "agentMessage"
        elif method == "item/commandExecution/outputDelta":
            raw["type"] = "commandExecution"
    turn_id = turn_id_from_result(dict(params))
    if turn_id is not None and timeline_item_turn_id(raw) is None:
        raw["turnId"] = turn_id
    return raw


def notification_delta(params: Mapping[str, Any]) -> str:
    for key in ("delta", "text", "outputDelta", "output_delta"):
        value = params.get(key)
        if isinstance(value, str):
            return value
    return ""


def content_hash(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str
    )
    return "sha256:" + hashlib.sha256(encoded.encode()).hexdigest()
