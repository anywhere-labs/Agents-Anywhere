from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

from connector.runtimes.codex.domain.sessions import (
    first_string_from_mapping,
    turn_id_from_result,
)


def raw_item_from_notification(
    method: str,
    params: Mapping[str, Any],
) -> dict[str, Any] | None:
    if method not in {
        "item/started",
        "item/completed",
        "item/agentMessage/delta",
        "item/commandExecution/outputDelta",
        "item/fileChange/patchUpdated",
        "item/reasoning/delta",
        "item/systemMessage",
        "item/runtimeMessage",
        "thread/compact/started",
        "thread/compact/failed",
        "thread/compacted",
    }:
        return None
    if method in {"thread/compact/started", "thread/compact/failed"}:
        thread_id = first_string_from_mapping(params, "threadId", "thread_id")
        return {
            "id": f"context_compaction_{thread_id}" if thread_id else "context_compaction",
            "type": "contextCompaction",
            "status": "failed" if method == "thread/compact/failed" else "inProgress",
            "role": "system",
        }
    if method == "thread/compacted":
        thread_id = first_string_from_mapping(params, "threadId", "thread_id")
        turn_id = turn_id_from_result(dict(params))
        return {
            "id": f"context_compaction_{thread_id}" if thread_id else "context_compaction",
            "type": "contextCompaction",
            "status": "completed",
            "role": "system",
            **({"turnId": turn_id} if turn_id is not None else {}),
        }
    item = params.get("item")
    if isinstance(item, dict):
        raw: dict[str, Any] = copy.deepcopy(item)
    else:
        raw = {
            key: copy.deepcopy(value)
            for key, value in params.items()
            if key
            not in {
                "platformSessionId",
                "platform_session_id",
                "sessionId",
                "session_id",
                "threadId",
                "thread_id",
                "turnId",
                "turn_id",
            }
        }
    item_id = first_string_from_mapping(params, "itemId", "item_id")
    if item_id is not None:
        raw["id"] = item_id
    if not isinstance(raw.get("type"), str) or not raw["type"]:
        if method == "item/agentMessage/delta":
            raw["type"] = "agentMessage"
        elif method == "item/commandExecution/outputDelta":
            raw["type"] = "commandExecution"
        elif method == "item/fileChange/patchUpdated":
            raw["type"] = "fileChange"
        elif method == "item/reasoning/delta":
            raw["type"] = "reasoning"
        elif method == "item/systemMessage":
            raw["type"] = "systemMessage"
        elif method == "item/runtimeMessage":
            raw["type"] = "runtimeMessage"
    if not isinstance(raw.get("id"), str) or not raw["id"]:
        raw_type = raw.get("type")
        if not isinstance(raw_type, str):
            return None
    turn_id = turn_id_from_result(dict(params))
    if turn_id is not None and event_raw_turn_id(raw) is None:
        raw["turnId"] = turn_id
    return raw


def event_raw_turn_id(raw: Mapping[str, Any]) -> str | None:
    for key in ("turnId", "turn_id"):
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def notification_delta(params: Mapping[str, Any]) -> str:
    for key in ("delta", "text", "outputDelta", "output_delta", "patch"):
        value = params.get(key)
        if isinstance(value, str):
            return value
    return ""
