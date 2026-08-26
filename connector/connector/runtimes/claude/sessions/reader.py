from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any

import asyncer

from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionState,
    timeline_content_hash,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.domain.pending_messages import (
    ClaudeClientMessageBinding,
    ClaudeHistoryUserMessage,
    ClaudePendingClientMessageRegistry,
)
from connector.runtimes.claude.domain.session import (
    ClaudeSession,
    stable_session_id,
)
from connector.runtimes.claude.history.state import history_cursor_key
from connector.runtimes.claude.sdk.client import SdkLoader, load_sdk
from connector.runtimes.claude.sdk.history import (
    list_sdk_sessions,
    read_sdk_session_info,
    read_sdk_session_messages,
)
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore
from connector.runtimes.claude.sessions.sync_state import ClaudeSessionSyncStateStore
from connector.runtimes.claude.timeline.messages import (
    ClaudeMessageProjector,
    message_id,
    message_role,
    message_text,
)

UNRESOLVED_LIVE_HISTORY_IMPORT_TTL_SECONDS = 120.0


@dataclass(slots=True)
class ClaudeSessionReader:
    config: RuntimeConfig
    host: RuntimeHostClient
    session_store: ClaudeSessionStore
    sdk_loader: SdkLoader | None
    sync_states: ClaudeSessionSyncStateStore
    pending_messages: ClaudePendingClientMessageRegistry

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        local_sessions = self.session_store.list_sessions(limit=limit)
        history_sessions = await self._list_history_sessions(
            limit=limit,
            cursor=cursor,
            force=force,
        )
        history_sessions = _filter_history_sessions_for_unresolved_live_sessions(
            runtime_sessions=self.session_store.sessions(),
            local_sessions=local_sessions,
            history_sessions=history_sessions,
        )
        history_sessions = _filter_history_sessions_for_active_local_sessions(
            runtime_sessions=self.session_store.sessions(),
            history_sessions=history_sessions,
        )
        return _merge_session_metas(local_sessions, history_sessions)[:limit]

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        local_session = self.session_store.get(session_id, external_session_id)
        if local_session is not None:
            return SessionState(
                session_id=local_session.session_id,
                external_session_id=local_session.external_session_id,
                runtime="claude",
                status="idle",
                selections=local_session.selections,
                metadata={"source": "claude.session.local.state"},
            )
        if external_session_id is None:
            return None
        info = await self._read_history_session_info(external_session_id)
        if info is None:
            return None
        return SessionState(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="claude",
            status="idle",
            selections={},
            metadata={"source": "claude.session.history.state"},
        )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        local_session = self.session_store.get(session_id, external_session_id)
        local_snapshot = self.session_store.snapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            limit=limit,
        )
        if external_session_id is None:
            return local_snapshot

        history_snapshot = await self._history_snapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            limit=limit,
        )
        if history_snapshot.items or local_session is None or not local_snapshot.items:
            return history_snapshot
        if local_snapshot.items:
            return local_snapshot
        return history_snapshot

    async def _list_history_sessions(
        self,
        limit: int,
        cursor: str | None,
        force: bool,
    ) -> tuple[SessionMeta, ...]:
        try:
            sdk = load_sdk(self.sdk_loader)
            sdk_sessions = await list_sdk_sessions(
                sdk,
                limit=limit,
                offset=_cursor_offset(cursor),
            )
        except Exception:  # noqa: BLE001
            logger.exception("Claude history session list failed")
            return ()

        metas: list[SessionMeta] = []
        for sdk_session in sdk_sessions:
            external_session_id = _string_attr(sdk_session, "session_id", "sessionId")
            if external_session_id is None:
                continue
            metas.append(
                await self._session_meta_from_sdk_session(
                    sdk_session,
                    external_session_id=external_session_id,
                    force=force,
                )
            )
        return tuple(metas)

    async def _session_meta_from_sdk_session(
        self,
        sdk_session: Any,
        *,
        external_session_id: str,
        force: bool,
    ) -> SessionMeta:
        session_id = stable_session_id(
            getattr(self.host, "session_namespace", self.host.connector_id),
            external_session_id,
        )
        title = _session_title(sdk_session)
        cwd = _string_attr(sdk_session, "cwd", "directory")
        ordering_time = _timestamp_from_epoch(
            _int_attr(sdk_session, "last_modified", "mtime", "updated_at")
            or _int_attr(sdk_session, "created_at")
        )
        sync_marker = _sync_marker(sdk_session)
        sync_key = _session_sync_key(external_session_id)
        previous_sync = await self.host.sync_state_read(sync_key)
        previous_marker = (
            previous_sync.get("marker") if isinstance(previous_sync, Mapping) else None
        )
        previous_cursor = await self.host.sync_state_read(
            history_cursor_key(external_session_id)
        )
        changed = force or previous_marker != sync_marker
        requires_timeline_sync = changed or previous_cursor is None
        sync_state = {
            "marker": sync_marker,
            "title": title,
            "cwd": cwd,
            "ordering_time": ordering_time,
            "session_id": session_id,
        }
        if requires_timeline_sync:
            self.sync_states.stage(
                external_session_id=external_session_id,
                sync_key=sync_key,
                state=sync_state,
            )
        return SessionMeta(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="claude",
            title=title,
            cwd=cwd,
            ordering_time=ordering_time,
            metadata={
                "source": "claude.session/list",
                "sync": {
                    "key": sync_key,
                    "marker": sync_marker,
                    "changed": changed,
                    "requires_timeline_sync": requires_timeline_sync,
                    "history_cursor_missing": previous_cursor is None,
                    "previous_marker": previous_marker,
                },
                "sdk": _sdk_session_metadata(sdk_session),
            },
        )

    async def _history_snapshot(
        self,
        session_id: str,
        external_session_id: str,
        limit: int | None,
    ) -> RuntimeTimelineSnapshot:
        try:
            sdk = load_sdk(self.sdk_loader)
            info = await read_sdk_session_info(
                sdk,
                session_id=external_session_id,
            )
            messages = await read_sdk_session_messages(
                sdk,
                session_id=external_session_id,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "Claude history snapshot failed external_session_id={}",
                external_session_id,
            )
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=external_session_id,
                runtime="claude",
                items=(),
                complete=False,
                metadata={"source": "claude.session.history", "error": "read_failed"},
            )

        session = ClaudeSession(
            session_id=session_id,
            external_session_id=external_session_id,
            title=_session_title(info),
            cwd=_string_attr(info, "cwd", "directory"),
            ordering_time=_timestamp_from_epoch(
                _int_attr(info, "last_modified", "mtime", "updated_at")
                or _int_attr(info, "created_at")
            ),
        )
        client_message_matches = await _match_history_client_messages(
            session=session,
            messages=messages,
            pending_messages=self.pending_messages,
        )
        items = await asyncer.asyncify(_history_items_from_messages)(
            session,
            messages,
            client_message_matches=client_message_matches,
        )
        if limit is not None:
            items = items[-limit:] if limit > 0 else ()
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="claude",
            items=items,
            complete=False,
            metadata={
                "source": "claude.session.history",
                "messageCount": len(messages),
                "sdk": _sdk_session_metadata(info),
            },
        )

    async def _read_history_session_info(self, external_session_id: str) -> Any | None:
        try:
            sdk = load_sdk(self.sdk_loader)
            return await read_sdk_session_info(sdk, session_id=external_session_id)
        except Exception:  # noqa: BLE001
            logger.exception(
                "Claude history session state read failed external_session_id={}",
                external_session_id,
            )
            return None


def _history_items_from_messages(
    session: ClaudeSession,
    messages: tuple[Any, ...],
    client_message_matches: Mapping[str, ClaudeClientMessageBinding] | None = None,
) -> tuple[RuntimeTimelineItem, ...]:
    projector = ClaudeMessageProjector()
    items: list[RuntimeTimelineItem] = []
    matches = client_message_matches or {}
    turn_seed: str | None = None
    turn_index = 0
    for index, message in enumerate(messages):
        role = message_role(message)
        text = message_text(message)
        native_id = message_id(message)
        if role == "user" and text:
            turn_index += 1
            turn_seed = native_id or f"{session.external_session_id}:{turn_index}"
        if turn_seed is None:
            turn_seed = native_id or f"{session.external_session_id}:initial"
        turn_id = _history_turn_id(session.external_session_id, turn_seed)
        items.extend(
            projector.tool_items_for_message(
                session=session,
                turn_id=turn_id,
                message=message,
            )
        )
        items.extend(
            projector.system_items_for_message(
                session=session,
                turn_id=turn_id,
                message=message,
                event="claude.history.system",
            )
        )
        if role not in {"user", "assistant", "system"} or not text:
            continue
        client_message = matches.get(native_id or "")
        items.append(
            projector.message_item(
                session=session,
                turn_id=turn_id,
                role=role,
                text=client_message.text if client_message is not None else text,
                event=f"claude.history.{role}",
                native_item_id=native_id or f"history_{index}",
                item_id=(
                    client_message.platform_item_id
                    if client_message is not None
                    else None
                ),
                client_message_id=(
                    client_message.client_message_id
                    if client_message is not None
                    else None
                ),
                attachments=(
                    client_message.attachments if client_message is not None else ()
                ),
            )
        )
    items.extend(projector.missing_history_tool_result_items(session=session))
    return _resequence_history_items(_dedupe_history_items(items))


async def _match_history_client_messages(
    *,
    session: ClaudeSession,
    messages: tuple[Any, ...],
    pending_messages: ClaudePendingClientMessageRegistry | None,
    prefer_latest: bool = True,
) -> dict[str, ClaudeClientMessageBinding]:
    if pending_messages is None or session.external_session_id is None:
        return {}
    user_messages = await asyncer.asyncify(_history_user_messages)(messages)
    return pending_messages.match_history_messages(
        session_id=session.session_id,
        external_session_id=session.external_session_id,
        messages=user_messages,
        prefer_latest=prefer_latest,
    )


def _history_user_messages(
    messages: tuple[Any, ...],
) -> tuple[ClaudeHistoryUserMessage, ...]:
    return tuple(
        ClaudeHistoryUserMessage(native_message_id=native_id, text=text)
        for message in messages
        for role in (message_role(message),)
        for native_id in (message_id(message),)
        for text in (message_text(message),)
        if role == "user" and native_id is not None and text is not None
    )


def _resequence_history_items(
    items: tuple[RuntimeTimelineItem, ...],
) -> tuple[RuntimeTimelineItem, ...]:
    return tuple(replace(item, order_seq=index) for index, item in enumerate(items, 1))


def _dedupe_history_items(
    items: list[RuntimeTimelineItem],
) -> tuple[RuntimeTimelineItem, ...]:
    deduped: list[RuntimeTimelineItem] = []
    index_by_id: dict[str, int] = {}
    for item in items:
        existing_index = index_by_id.get(item.id)
        if existing_index is None:
            index_by_id[item.id] = len(deduped)
            deduped.append(item)
            continue
        deduped[existing_index] = _merge_duplicate_history_item(
            deduped[existing_index],
            item,
        )
    return tuple(deduped)


def _merge_duplicate_history_item(
    existing: RuntimeTimelineItem,
    incoming: RuntimeTimelineItem,
) -> RuntimeTimelineItem:
    if existing.type != "tool" or incoming.type != "tool":
        return incoming

    content = {**existing.content, **incoming.content}
    return replace(
        incoming,
        order_seq=existing.order_seq,
        content=content,
        content_hash=timeline_content_hash(
            item_type=incoming.type,  # type: ignore[arg-type]
            status=incoming.status,  # type: ignore[arg-type]
            role=incoming.role,  # type: ignore[arg-type]
            content=content,
        ),
    )


def _merge_session_metas(
    local_sessions: tuple[SessionMeta, ...],
    history_sessions: tuple[SessionMeta, ...],
) -> tuple[SessionMeta, ...]:
    merged: list[SessionMeta] = []
    index_by_session_id: dict[str, int] = {}
    index_by_external_id: dict[str, int] = {}
    for session in (*local_sessions, *history_sessions):
        existing_index = index_by_session_id.get(session.session_id)
        if existing_index is None and session.external_session_id is not None:
            existing_index = index_by_external_id.get(session.external_session_id)
        if existing_index is not None:
            merged[existing_index] = _merge_session_meta(
                merged[existing_index],
                session,
            )
            continue

        index_by_session_id[session.session_id] = len(merged)
        if session.external_session_id is not None:
            index_by_external_id[session.external_session_id] = len(merged)
        merged.append(session)
    return tuple(
        sorted(
            merged,
            key=lambda item: item.ordering_time or "",
            reverse=True,
        )
    )


def _filter_history_sessions_for_unresolved_live_sessions(
    *,
    runtime_sessions: tuple[ClaudeSession, ...],
    local_sessions: tuple[SessionMeta, ...],
    history_sessions: tuple[SessionMeta, ...],
) -> tuple[SessionMeta, ...]:
    barriers = _unresolved_live_session_barriers(runtime_sessions)
    if not barriers:
        return history_sessions

    local_session_ids = {session.session_id for session in local_sessions}
    local_external_session_ids = {
        session.external_session_id
        for session in local_sessions
        if session.external_session_id is not None
    }
    filtered: list[SessionMeta] = []
    for session in history_sessions:
        if _session_meta_source(session) != "claude.session/list":
            filtered.append(session)
            continue
        if session.session_id in local_session_ids:
            filtered.append(session)
            continue
        if (
            session.external_session_id is not None
            and session.external_session_id in local_external_session_ids
        ):
            filtered.append(session)

    return tuple(filtered)


def _filter_history_sessions_for_active_local_sessions(
    *,
    runtime_sessions: tuple[ClaudeSession, ...],
    history_sessions: tuple[SessionMeta, ...],
) -> tuple[SessionMeta, ...]:
    active_session_ids = {
        session.session_id
        for session in runtime_sessions
        if session.execution is not None
    }
    active_external_session_ids = {
        session.external_session_id
        for session in runtime_sessions
        if session.execution is not None and session.external_session_id is not None
    }
    if not active_session_ids and not active_external_session_ids:
        return history_sessions
    return tuple(
        session
        for session in history_sessions
        if session.session_id not in active_session_ids
        and session.external_session_id not in active_external_session_ids
    )


def _unresolved_live_session_barriers(
    sessions: tuple[ClaudeSession, ...],
) -> tuple[str, ...]:
    now = time.monotonic()
    barriers: list[str] = []
    for session in sessions:
        if session.external_session_id is not None:
            continue
        if session.execution is None:
            continue
        started_at = session.active_turn_started_at_monotonic
        if started_at is None:
            continue
        age = now - started_at
        if age > UNRESOLVED_LIVE_HISTORY_IMPORT_TTL_SECONDS:
            continue
        barriers.append(session.session_id)
    return tuple(barriers)


def _session_meta_source(session: SessionMeta) -> str:
    source = session.metadata.get("source")
    return str(source) if source is not None else "-"


def _merge_session_meta(primary: SessionMeta, secondary: SessionMeta) -> SessionMeta:
    metadata = dict(primary.metadata)
    secondary_metadata = dict(secondary.metadata)
    primary_sync = metadata.get("sync")
    secondary_sync = secondary_metadata.get("sync")
    if isinstance(primary_sync, Mapping) and isinstance(secondary_sync, Mapping):
        metadata["sync"] = {
            **primary_sync,
            "sources": _sync_sources(primary, secondary),
            "history": dict(secondary_sync)
            if secondary.metadata.get("source") == "claude.session/list"
            else primary_sync.get("history"),
            "requires_timeline_sync": (
                primary_sync.get("requires_timeline_sync") is True
                or secondary_sync.get("requires_timeline_sync") is True
            ),
            "changed": (
                primary_sync.get("changed") is True
                or secondary_sync.get("changed") is True
            ),
        }
    return SessionMeta(
        session_id=primary.session_id,
        external_session_id=primary.external_session_id
        or secondary.external_session_id,
        runtime=primary.runtime,
        title=primary.title or secondary.title,
        cwd=primary.cwd or secondary.cwd,
        ordering_time=max(
            primary.ordering_time or "",
            secondary.ordering_time or "",
        )
        or None,
        metadata=metadata,
    )


def _sync_sources(primary: SessionMeta, secondary: SessionMeta) -> tuple[str, ...]:
    sources: list[str] = []
    for session in (primary, secondary):
        source = session.metadata.get("source")
        if isinstance(source, str) and source not in sources:
            sources.append(source)
    return tuple(sources)


def _session_sync_key(external_session_id: str) -> str:
    return f"claude/session-sync/{external_session_id}"


def _cursor_offset(cursor: str | None) -> int:
    if cursor is None:
        return 0
    try:
        offset = int(cursor)
    except ValueError:
        return 0
    return max(offset, 0)


def _session_title(session: Any) -> str | None:
    return _string_attr(session, "custom_title", "summary", "first_prompt", "title")


def _sync_marker(session: Any) -> str:
    payload = {
        "lastModified": _int_attr(session, "last_modified", "mtime", "updated_at"),
        "fileSize": _int_attr(session, "file_size"),
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _sdk_session_metadata(session: Any) -> dict[str, Any]:
    if session is None:
        return {}
    metadata: dict[str, Any] = {}
    for key in (
        "last_modified",
        "file_size",
        "created_at",
        "git_branch",
        "tag",
    ):
        value = _attr(session, key)
        if value is not None:
            metadata[key] = value
    return metadata


def _history_turn_id(
    external_session_id: str | None,
    turn_seed: str,
) -> str:
    digest = hashlib.sha256(
        f"{external_session_id or 'unknown'}:{turn_seed}".encode()
    ).hexdigest()[:24]
    return f"turn_claude_{digest}"


def _timestamp_from_epoch(value: int | None) -> str | None:
    if value is None:
        return None
    seconds = value / 1000 if value > 10_000_000_000 else value
    return datetime.fromtimestamp(seconds, tz=UTC).isoformat().replace("+00:00", "Z")


def _int_attr(item: Any, *names: str) -> int | None:
    for name in names:
        value = _attr(item, name)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            return value
        if isinstance(value, str):
            try:
                return int(value)
            except ValueError:
                continue
    return None


def _string_attr(item: Any, *names: str) -> str | None:
    for name in names:
        value = _attr(item, name)
        if isinstance(value, str) and value:
            return value
    return None


def _attr(item: Any, name: str) -> Any:
    if isinstance(item, Mapping):
        return item.get(name)
    return getattr(item, name, None)
