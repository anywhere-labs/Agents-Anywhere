from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from connector.runtimes.session_identity import stable_runtime_session_id


def stable_session_id(connector_id: str, thread_id: str) -> str:
    return stable_runtime_session_id(connector_id, "codex", thread_id)


def thread_id_from_result(value: dict[str, Any]) -> str | None:
    thread = value.get("thread") if isinstance(value.get("thread"), dict) else value
    if not isinstance(thread, dict):
        return None
    for key in ("id", "thread_id", "threadId"):
        value = thread.get(key)
        if isinstance(value, str) and value:
            return value
    nested = thread.get("thread")
    if isinstance(nested, dict) and isinstance(nested.get("id"), str):
        return nested["id"]
    return None


def turn_id_from_result(value: dict[str, Any]) -> str | None:
    turn = value.get("turn") if isinstance(value.get("turn"), dict) else value
    if not isinstance(turn, dict):
        return None
    for key in ("id", "turn_id", "turnId"):
        value = turn.get(key)
        if isinstance(value, str) and value:
            return value
    nested = turn.get("turn")
    if isinstance(nested, dict) and isinstance(nested.get("id"), str):
        return nested["id"]
    return None


def session_id_from_notification(params: Mapping[str, Any]) -> str | None:
    for key in ("platformSessionId", "sessionId", "session_id"):
        value = params.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def local_thread_state(thread_ref: dict[str, Any]) -> str:
    for key in ("localState", "local_state", "lifecycleState", "lifecycle_state"):
        value = thread_ref.get(key)
        if isinstance(value, str):
            normalized = value.lower()
            if normalized in {
                "active",
                "archived",
                "deleted",
                "unresumable",
                "unknown",
            }:
                return normalized
    status = thread_ref.get("status")
    if isinstance(status, dict):
        status = status.get("type") or status.get("state")
    if isinstance(status, str):
        normalized_status = status.lower()
        if normalized_status in {"archived", "deleted", "unresumable"}:
            return normalized_status
    for key in ("archived", "isArchived", "is_archived"):
        if thread_ref.get(key) is True:
            return "archived"
    for key in ("deleted", "isDeleted", "is_deleted"):
        if thread_ref.get(key) is True:
            return "deleted"
    if (
        thread_ref.get("resumeSupported") is False
        or thread_ref.get("resumable") is False
    ):
        return "unresumable"
    return "active"


def thread_title(thread_ref: dict[str, Any]) -> str | None:
    return first_string(thread_ref, "name", "title", "summary")


def thread_cwd(thread_ref: dict[str, Any]) -> str | None:
    value = (
        thread_ref.get("cwd")
        or thread_ref.get("workingDirectory")
        or thread_ref.get("working_directory")
    )
    return value if isinstance(value, str) and value else None


def thread_ordering_time(thread_ref: dict[str, Any]) -> str | None:
    value = (
        thread_ref.get("updatedAt")
        or thread_ref.get("updated_at")
        or thread_ref.get("createdAt")
        or thread_ref.get("created_at")
    )
    return str(value) if value is not None else None


def thread_sync_marker(thread_ref: dict[str, Any]) -> str | None:
    marker: dict[str, Any] = {}
    for key in (
        "updatedAt",
        "updated_at",
        "revision",
        "rev",
        "version",
        "timelineRevision",
        "timeline_revision",
        "lastItemId",
        "last_item_id",
        "lastMessageId",
        "last_message_id",
        "messageCount",
        "message_count",
        "turnCount",
        "turn_count",
    ):
        value = thread_ref.get(key)
        if value is not None:
            marker[key] = value
    if not marker:
        return None
    encoded = json.dumps(
        marker,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return "sha256:" + hashlib.sha256(encoded.encode()).hexdigest()


def first_string_from_mapping(mapping: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def first_string(item: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return None
