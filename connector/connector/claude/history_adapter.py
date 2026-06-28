from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from connector.logging import logger

from connector.claude.normalizers import ClaudeTranscriptNormalizer
from connector.claude.path_utils import stable_claude_session_id
from connector.claude.timeline_identity import content_hash
from connector.claude.timeline_reducer import ClaudeTimelineReducer
from connector.sync_state import SyncStateStore
from connector.time import utc_now


@dataclass(frozen=True, slots=True)
class PendingClientMessage:
    client_message_id: str
    text: str | None = None
    attachments: list[dict[str, Any]] | None = None


@dataclass(frozen=True, slots=True)
class _HistoryCursor:
    last_modified: int | None
    file_size: int | None
    message_count: int
    last_message_uuid: str | None


@dataclass(slots=True)
class _HistoryTurn:
    turn_id: str
    raw_messages: list[dict[str, Any]] = field(default_factory=list)


@dataclass(slots=True)
class ClaudeHistoryAdapter:
    """Claude history scanner backed by Claude Agent SDK session APIs."""

    sdk_module: Any | None = None
    sync_state_store: SyncStateStore | None = None
    _cursors: dict[str, _HistoryCursor] = field(default_factory=dict)

    def forget_sync_state(self) -> None:
        self._cursors.clear()

    def forget_persisted_sync_state(self, connector_id: str) -> None:
        self.forget_sync_state()
        if self.sync_state_store is not None:
            self.sync_state_store.delete_runtime("claude", connector_id)

    def apply_history_sync_state(self, _state: list[dict[str, Any]]) -> None:
        # Reserved for future persisted SDK history state. For now, the
        # connector rebuilds this lightweight cache as it scans.
        return

    async def sync_existing_sessions(
        self,
        connector_id: str,
        *,
        limit: int = 100,
        force: bool = False,
        skip_external_session_ids: set[str] | None = None,
        notification_sink: Callable[[list[dict[str, Any]]], Awaitable[None]] | None = None,
    ) -> dict[str, Any]:
        sdk = self._load_sdk()
        sessions = _list_sessions(sdk, limit=limit)
        notifications: list[dict[str, Any]] = []
        synced: list[str] = []
        skipped: list[str] = []
        skipped_active = skip_external_session_ids or set()

        started = time.perf_counter()
        for session in sessions:
            external_session_id = _string_attr(session, "session_id")
            if external_session_id is None:
                continue
            if external_session_id in skipped_active:
                skipped.append(external_session_id)
                continue
            session_id = stable_claude_session_id(connector_id, external_session_id)

            messages = _get_session_messages(
                sdk,
                external_session_id,
                directory=_string_attr(session, "cwd"),
            )
            cursor = _cursor_for(session, messages)
            previous_cursor = self._previous_cursor(connector_id, external_session_id)
            if not force and previous_cursor == cursor:
                skipped.append(external_session_id)
                continue
            sync_messages = messages if previous_cursor is None else _messages_after_cursor(messages, previous_cursor)
            if not sync_messages:
                self._store_cursor(connector_id, external_session_id, cursor)
                skipped.append(external_session_id)
                continue

            thread_notifications = _backend_notifications_from_sdk_history(
                session_id=session_id,
                external_session_id=external_session_id,
                session_info=session,
                messages=sync_messages,
                timeline_method="timeline.sync" if previous_cursor is None else "timeline.itemUpsert",
            )
            self._store_cursor(connector_id, external_session_id, cursor)
            if notification_sink is not None:
                await notification_sink(thread_notifications)
            else:
                notifications.extend(thread_notifications)
            synced.append(session_id)

        elapsed_ms = (time.perf_counter() - started) * 1000
        logger.info(
            "claude sdk history sync connector_id={} synced={} skipped={} elapsed_ms={:.1f}",
            connector_id,
            len(synced),
            len(skipped),
            elapsed_ms,
        )
        return {
            "threads": synced,
            "skippedThreads": skipped,
            "backendNotifications": notifications,
        }

    async def sync_session(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = _required(params, "sessionId")
        external_session_id = _required(params, "externalSessionId")
        pending_client_messages = _pending_client_messages(params.get("pendingClientMessages"))

        sdk = self._load_sdk()
        cwd = params.get("cwd") if isinstance(params.get("cwd"), str) else None
        session_info = _get_session_info(sdk, external_session_id, directory=cwd)
        messages = _get_session_messages(sdk, external_session_id, directory=cwd)
        self._cursors[external_session_id] = _cursor_for(session_info, messages)
        return {
            "backendNotifications": _backend_notifications_from_sdk_history(
                session_id=session_id,
                external_session_id=external_session_id,
                session_info=session_info,
                messages=messages,
                fallback_cwd=cwd,
                pending_client_messages=pending_client_messages,
            )
        }

    async def mark_session_consumed(
        self,
        *,
        connector_id: str | None = None,
        external_session_id: str | None,
        cwd: str | None = None,
    ) -> None:
        if external_session_id is None:
            return
        sdk = self._load_sdk()
        session_info = _get_session_info(sdk, external_session_id, directory=cwd)
        messages = _get_session_messages(sdk, external_session_id, directory=cwd)
        cursor = _cursor_for(session_info, messages)
        if connector_id is None:
            self._cursors[external_session_id] = cursor
        else:
            self._store_cursor(connector_id, external_session_id, cursor)

    def _previous_cursor(self, connector_id: str, external_session_id: str) -> _HistoryCursor | None:
        cursor = self._cursors.get(external_session_id)
        if cursor is not None:
            return cursor
        if self.sync_state_store is None:
            return None
        state = self.sync_state_store.get("claude", connector_id, external_session_id)
        if state is None:
            return None
        cursor = _cursor_from_state(state.fingerprint, state.cursor)
        if cursor is not None:
            self._cursors[external_session_id] = cursor
        return cursor

    def _store_cursor(self, connector_id: str, external_session_id: str, cursor: _HistoryCursor) -> None:
        self._cursors[external_session_id] = cursor
        if self.sync_state_store is not None:
            self.sync_state_store.set(
                "claude",
                connector_id,
                external_session_id,
                fingerprint=_cursor_fingerprint_json(cursor),
                cursor=_cursor_position_json(cursor),
            )

    def _load_sdk(self) -> Any:
        if self.sdk_module is not None:
            return self.sdk_module
        try:
            import claude_agent_sdk  # type: ignore[import-not-found]
        except ModuleNotFoundError as exc:
            raise RuntimeError("claude-agent-sdk is not installed") from exc
        return claude_agent_sdk

def _backend_notifications_from_sdk_history(
    *,
    session_id: str,
    external_session_id: str,
    session_info: Any,
    messages: list[Any],
    fallback_cwd: str | None = None,
    pending_client_messages: list[PendingClientMessage] | None = None,
    timeline_method: str = "timeline.sync",
) -> list[dict[str, Any]]:
    source_observed_at = _timestamp_from_ms(_int_attr(session_info, "last_modified")) or utc_now()
    session_update: dict[str, Any] = {
        "sessionId": session_id,
        "runtime": "claude",
        "externalSessionId": external_session_id,
        "status": "idle",
        "lastSyncedAt": utc_now(),
        "sourceObservedAt": source_observed_at,
        "lastActivityAt": source_observed_at,
    }
    title = _string_attr(session_info, "custom_title") or _string_attr(session_info, "summary")
    cwd = _string_attr(session_info, "cwd") or fallback_cwd
    if title:
        session_update["title"] = title
    if cwd:
        session_update["cwd"] = cwd

    notifications = [{"method": "session.updated", "params": session_update}]
    timeline_items = _timeline_items_from_messages(
        session_id=session_id,
        external_session_id=external_session_id,
        session_info=session_info,
        messages=messages,
        pending_client_messages=pending_client_messages,
    )
    if timeline_items:
        if timeline_method == "timeline.itemUpsert":
            for item in timeline_items:
                notifications.append(
                    {
                        "method": "timeline.itemUpsert",
                        "params": {
                            "sessionId": session_id,
                            "sourceObservedAt": source_observed_at,
                            "item": item,
                        },
                    }
                )
        else:
            notifications.append(
                {
                    "method": "timeline.sync",
                    "params": {
                        "sessionId": session_id,
                        "sourceObservedAt": source_observed_at,
                        "items": timeline_items,
                    },
                }
            )
    return notifications


def _timeline_items_from_messages(
    *,
    session_id: str,
    external_session_id: str,
    session_info: Any,
    messages: list[Any],
    pending_client_messages: list[PendingClientMessage] | None = None,
) -> list[dict[str, Any]]:
    turns = _partition_history_turns(messages, session_info=session_info)
    out: list[dict[str, Any]] = []
    next_order = 1
    matcher = _PendingClientMessageMatcher(pending_client_messages or [])
    for turn in turns:
        if not turn.raw_messages:
            continue
        timestamp = _raw_timestamp(turn.raw_messages[0])
        turn_start = _turn_boundary_item(
            session_id=session_id,
            external_session_id=external_session_id,
            turn_id=turn.turn_id,
            item_type="turn.start",
            status="running",
            result=None,
            timestamp=timestamp,
            order_seq=next_order,
        )
        next_order += 1
        out.append(turn_start)

        events = ClaudeTranscriptNormalizer().normalize(turn.raw_messages)
        _attach_pending_client_messages(events, matcher)
        reduced = ClaudeTimelineReducer().reduce(
            session_id=session_id,
            turn_id=turn.turn_id,
            events=events,
        )
        for item in _visible_history_items(reduced):
            adjusted = dict(item)
            adjusted["orderSeq"] = next_order
            next_order += 1
            out.append(adjusted)

        turn_end = _turn_boundary_item(
            session_id=session_id,
            external_session_id=external_session_id,
            turn_id=turn.turn_id,
            item_type="turn.end",
            status="done",
            result="completed",
            timestamp=_raw_timestamp(turn.raw_messages[-1]),
            order_seq=next_order,
        )
        next_order += 1
        out.append(turn_end)
    return out


def _partition_history_turns(messages: list[Any], *, session_info: Any) -> list[_HistoryTurn]:
    turns: list[_HistoryTurn] = []
    current: _HistoryTurn | None = None
    for index, message in enumerate(messages):
        raw = _raw_from_session_message(message, session_info=session_info, index=index)
        if raw is None:
            continue
        if _is_user_prompt_raw(raw):
            if current is not None and current.raw_messages:
                turns.append(current)
            current = _HistoryTurn(turn_id=_raw_uuid(raw))
        elif current is None:
            current = _HistoryTurn(turn_id=_raw_uuid(raw))
        current.raw_messages.append(raw)
    if current is not None and current.raw_messages:
        turns.append(current)
    return turns


def _raw_from_session_message(message: Any, *, session_info: Any, index: int) -> dict[str, Any] | None:
    raw_message = getattr(message, "message", None)
    if not isinstance(raw_message, dict):
        return None
    message_uuid = getattr(message, "uuid", None)
    if not isinstance(message_uuid, str) or not message_uuid:
        return None
    sdk_session_id = getattr(message, "session_id", None)
    if not isinstance(sdk_session_id, str) or not sdk_session_id:
        sdk_session_id = _string_attr(session_info, "session_id") or "unknown"

    normalized_message = dict(raw_message)
    role = normalized_message.get("role")
    message_type = getattr(message, "type", None)
    if not isinstance(role, str) and message_type in {"user", "assistant"}:
        normalized_message["role"] = message_type

    return {
        "uuid": message_uuid,
        "session_id": sdk_session_id,
        "timestamp": _stable_message_timestamp(session_info, index),
        "message": normalized_message,
    }


def _visible_history_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [item for item in items if _is_visible_history_item(item)]


def _is_visible_history_item(item: dict[str, Any]) -> bool:
    if item.get("type") != "tool":
        return True
    content = item.get("content")
    if not isinstance(content, dict):
        return False
    if content.get("kind") != "file_change":
        return False
    status = item.get("status")
    has_call = isinstance(content.get("toolUseId"), str) and isinstance(content.get("toolName"), str)
    has_result = status in {"done", "failed"} and (
        "result" in content or "outputText" in content or "error" in content
    )
    return has_call and has_result


class _PendingClientMessageMatcher:
    def __init__(self, messages: list[PendingClientMessage]) -> None:
        self._messages = list(messages)

    def pop_match(self, text: str) -> PendingClientMessage | None:
        for index, message in enumerate(self._messages):
            expected = message.text
            if expected is None or _client_message_text_matches(text, expected):
                return self._messages.pop(index)
        return None


def _attach_pending_client_messages(
    events: list[Any],
    matcher: _PendingClientMessageMatcher,
) -> None:
    for event in events:
        if event.role != "user" or event.text is None or event.toolUseId:
            continue
        pending = matcher.pop_match(event.text)
        if pending is None:
            continue
        event.clientMessageId = pending.client_message_id
        if pending.attachments:
            event.attachments = pending.attachments


def _pending_client_messages(value: Any) -> list[PendingClientMessage]:
    if not isinstance(value, list):
        return []
    out: list[PendingClientMessage] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        client_message_id = item.get("clientMessageId")
        if not isinstance(client_message_id, str) or not client_message_id:
            continue
        text = item.get("text") if isinstance(item.get("text"), str) else None
        attachments = item.get("attachments")
        if not isinstance(attachments, list):
            attachments = None
        out.append(
            PendingClientMessage(
                client_message_id=client_message_id,
                text=text,
                attachments=attachments,
            )
        )
    return out


def _client_message_text_matches(actual: str, expected: str) -> bool:
    if actual == expected:
        return True
    return actual.startswith(expected) and actual[len(expected) :].startswith("\n\n[")


def _is_user_prompt_raw(raw: dict[str, Any]) -> bool:
    message = raw.get("message") if isinstance(raw.get("message"), dict) else {}
    if message.get("role") != "user":
        return False
    content = message.get("content")
    if isinstance(content, str):
        return bool(content.strip())
    if not isinstance(content, list):
        return False
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str) and block["text"].strip():
            return True
    return False


def _turn_boundary_item(
    *,
    session_id: str,
    external_session_id: str,
    turn_id: str,
    item_type: str,
    status: str,
    result: str | None,
    timestamp: str | None,
    order_seq: int,
) -> dict[str, Any]:
    is_end = item_type == "turn.end"
    derived_key = "turn-end" if is_end else "turn-start"
    content = {"stopReason": result, "result": result} if is_end else {}
    item_id = f"{turn_id}:{derived_key}"
    now = timestamp or utc_now()
    return {
        "id": item_id,
        "sessionId": session_id,
        "turnId": turn_id,
        "type": item_type,
        "status": status,
        "role": None,
        "content": content,
        "source": {
            "runtime": "claude",
            "sessionId": external_session_id,
            "turnId": turn_id,
            "itemId": item_id,
            "itemType": item_type,
            "event": item_type,
            "derivedKey": derived_key,
        },
        "orderSeq": order_seq,
        "revision": 1,
        "contentHash": content_hash(content),
        "createdAt": now,
        "updatedAt": now,
        "completedAt": now if is_end else None,
    }


def _list_sessions(sdk: Any, *, limit: int) -> list[Any]:
    list_sessions = getattr(sdk, "list_sessions", None)
    if not callable(list_sessions):
        raise RuntimeError("claude-agent-sdk does not expose list_sessions()")
    return list(list_sessions(limit=limit))


def _get_session_info(sdk: Any, session_id: str, *, directory: str | None) -> Any:
    get_session_info = getattr(sdk, "get_session_info", None)
    if not callable(get_session_info):
        return None
    try:
        return get_session_info(session_id, directory=directory)
    except TypeError:
        return get_session_info(session_id)


def _get_session_messages(sdk: Any, session_id: str, *, directory: str | None) -> list[Any]:
    get_session_messages = getattr(sdk, "get_session_messages", None)
    if not callable(get_session_messages):
        raise RuntimeError("claude-agent-sdk does not expose get_session_messages()")
    try:
        return list(get_session_messages(session_id, directory=directory))
    except TypeError:
        return list(get_session_messages(session_id))


def _cursor_for(session_info: Any, messages: list[Any]) -> _HistoryCursor:
    last_message_uuid = None
    if messages:
        candidate = getattr(messages[-1], "uuid", None)
        last_message_uuid = candidate if isinstance(candidate, str) and candidate else None
    return _HistoryCursor(
        last_modified=_int_attr(session_info, "last_modified"),
        file_size=_int_attr(session_info, "file_size"),
        message_count=len(messages),
        last_message_uuid=last_message_uuid,
    )


def _cursor_fingerprint_json(cursor: _HistoryCursor) -> dict[str, Any]:
    return {
        "lastModified": cursor.last_modified,
        "fileSize": cursor.file_size,
    }


def _cursor_position_json(cursor: _HistoryCursor) -> dict[str, Any]:
    return {
        "messageCount": cursor.message_count,
        "lastMessageUuid": cursor.last_message_uuid,
    }


def _cursor_from_state(
    fingerprint: dict[str, Any] | None,
    cursor: dict[str, Any] | None,
) -> _HistoryCursor | None:
    if fingerprint is None and cursor is None:
        return None
    fingerprint = fingerprint or {}
    cursor = cursor or {}
    return _HistoryCursor(
        last_modified=_optional_int(fingerprint.get("lastModified")),
        file_size=_optional_int(fingerprint.get("fileSize")),
        message_count=_optional_int(cursor.get("messageCount")) or 0,
        last_message_uuid=_optional_json_string(cursor.get("lastMessageUuid")),
    )


def _messages_after_cursor(messages: list[Any], cursor: _HistoryCursor) -> list[Any]:
    if cursor.last_message_uuid:
        for index, message in enumerate(messages):
            if getattr(message, "uuid", None) == cursor.last_message_uuid:
                return messages[index + 1 :]
    if cursor.message_count > 0:
        return messages[cursor.message_count :]
    return messages


def _optional_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _optional_json_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _stable_message_timestamp(session_info: Any, index: int) -> str:
    base_ms = (
        _int_attr(session_info, "created_at")
        or _int_attr(session_info, "last_modified")
        or int(time.time() * 1000)
    )
    return _timestamp_from_ms(base_ms + index) or utc_now()


def _timestamp_from_ms(value: int | None) -> str | None:
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, tz=UTC).isoformat().replace("+00:00", "Z")


def _raw_timestamp(raw: dict[str, Any]) -> str | None:
    timestamp = raw.get("timestamp")
    return timestamp if isinstance(timestamp, str) and timestamp else None


def _raw_uuid(raw: dict[str, Any]) -> str:
    value = raw.get("uuid")
    return value if isinstance(value, str) and value else "history-unknown"


def _string_attr(value: Any, attr: str) -> str | None:
    candidate = getattr(value, attr, None)
    return candidate if isinstance(candidate, str) and candidate else None


def _int_attr(value: Any, attr: str) -> int | None:
    candidate = getattr(value, attr, None)
    return candidate if isinstance(candidate, int) else None


def _required(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} is required")
    return value


__all__ = ["ClaudeHistoryAdapter"]
