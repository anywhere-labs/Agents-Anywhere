"""Record usage events at the moment platform activity happens.

The recorder keeps the hot paths cheap: events are appended to an in-memory
batch and written by a sweeper task once per second. Before ``start()`` runs
(for example under the test client, which does not run the lifespan) events
are written synchronously so tests stay deterministic. Writes never raise into
the caller; a lost statistics row must not fail a user request.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

from loguru import logger

from agent_server.core.models import NoticeIn, SessionView
from agent_server.core.usage import (
    APPROVAL_RESOLVED_STATUSES,
    EVENT_APPROVAL_REQUESTED,
    EVENT_APPROVAL_RESOLVED,
    EVENT_CONNECTOR_ONLINE,
    EVENT_MESSAGE_SENT,
    EVENT_RUNTIME_ERROR,
    EVENT_SESSION_CREATED,
    EVENT_SESSION_VIEWED,
    EVENT_TURN_ENDED,
    EVENT_USER_ACTIVE,
    UsageEvent,
    hour_bucket,
)
from agent_server.core.utc import utc_now
from agent_server.services.repository_ports import UsageEventRepository

DEFAULT_FLUSH_INTERVAL_SECONDS = 1.0
DEFAULT_MAX_BATCH = 500
DEFAULT_USER_ACTIVE_INTERVAL_SECONDS = 300.0
# Opening the same session again within this window (a reconnect, a refresh,
# a double-mounted view) is still the same read.
DEFAULT_SESSION_VIEW_INTERVAL_SECONDS = 60.0
# A turn longer than this is almost certainly measured against a stale
# message (for example a takeover session driven locally in between).
MAX_TURN_DURATION_MS = 6 * 60 * 60 * 1000
_MAX_TRACKED_USERS = 50_000
_MAX_TRACKED_SESSIONS = 10_000
_MAX_TRACKED_VIEWS = 50_000


class UsageRecorder:
    def __init__(
        self,
        store: UsageEventRepository,
        *,
        flush_interval_seconds: float = DEFAULT_FLUSH_INTERVAL_SECONDS,
        max_batch: int = DEFAULT_MAX_BATCH,
        user_active_interval_seconds: float = DEFAULT_USER_ACTIVE_INTERVAL_SECONDS,
        session_view_interval_seconds: float = DEFAULT_SESSION_VIEW_INTERVAL_SECONDS,
    ) -> None:
        self._store = store
        self._flush_interval_seconds = max(0.05, flush_interval_seconds)
        self._max_batch = max(1, max_batch)
        self._user_active_interval_seconds = max(0.0, user_active_interval_seconds)
        self._session_view_interval_seconds = max(0.0, session_view_interval_seconds)
        self._pending: list[dict[str, Any]] = []
        self._flush_lock = asyncio.Lock()
        self._sweeper_task: asyncio.Task[None] | None = None
        self._closed = False
        self._user_seen: OrderedDict[str, float] = OrderedDict()
        self._views_seen: OrderedDict[tuple[str, str], float] = OrderedDict()
        self._last_message_at: OrderedDict[str, str] = OrderedDict()

    # --- lifecycle ----------------------------------------------------------

    @property
    def buffered(self) -> bool:
        return self._sweeper_task is not None and not self._closed

    async def start(self) -> None:
        if self._closed:
            raise RuntimeError("usage recorder is closed")
        if self._sweeper_task is not None:
            return
        self._sweeper_task = asyncio.create_task(
            self._run_sweeper(), name="usage-recorder"
        )

    async def close(self) -> None:
        if self._closed:
            return
        task = self._sweeper_task
        self._sweeper_task = None
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        await self.flush()
        self._closed = True

    async def _run_sweeper(self) -> None:
        while True:
            await asyncio.sleep(self._flush_interval_seconds)
            try:
                await self.flush()
            except Exception:  # noqa: BLE001 - keep the sweeper alive
                logger.exception("usage recorder sweep failed")

    async def flush(self) -> None:
        async with self._flush_lock:
            pending, self._pending = self._pending, []
            if pending:
                await self._write(pending)

    async def _write(self, rows: list[dict[str, Any]]) -> None:
        try:
            await self._store.insert_usage_events(rows)
        except Exception as exc:  # noqa: BLE001 - statistics must not break requests
            logger.warning("usage events dropped count={} error={}", len(rows), exc)

    # --- recording ----------------------------------------------------------

    async def record(self, event: UsageEvent) -> None:
        if event.event_type == EVENT_MESSAGE_SENT and event.session_id:
            self._remember_message(event.session_id, event.occurred_at)
        row = event.row()
        if self.buffered:
            self._pending.append(row)
            if len(self._pending) >= self._max_batch:
                await self.flush()
            return
        await self._write([row])

    async def touch_user(self, user_id: str, *, occurred_at: str | None = None) -> bool:
        """Record platform presence for a user, throttled per process."""

        if not _admit(
            self._user_seen,
            user_id,
            interval_seconds=self._user_active_interval_seconds,
            max_entries=_MAX_TRACKED_USERS,
        ):
            return False
        timestamp = occurred_at or utc_now()
        await self.record(
            UsageEvent(
                EVENT_USER_ACTIVE,
                timestamp,
                user_id=user_id,
                dedupe_key=f"active:{user_id}:{hour_bucket(timestamp)}",
            )
        )
        return True

    async def touch_session_view(
        self, session: SessionView, *, user_id: str, occurred_at: str | None = None
    ) -> bool:
        """Record that a user opened a session. Every open counts as one read,
        except repeats of the same user and session inside the view window.
        """

        if not _admit(
            self._views_seen,
            (user_id, session.id),
            interval_seconds=self._session_view_interval_seconds,
            max_entries=_MAX_TRACKED_VIEWS,
        ):
            return False
        await self.record(
            session_viewed_event(session, user_id=user_id, occurred_at=occurred_at)
        )
        return True

    async def last_message_sent_at(self, session_id: str) -> str | None:
        cached = self._last_message_at.get(session_id)
        if cached is not None:
            return cached
        try:
            return await self._store.latest_usage_event_at(
                session_id=session_id, event_type=EVENT_MESSAGE_SENT
            )
        except Exception as exc:  # noqa: BLE001 - statistics must not break ingest
            logger.warning("usage lookup failed session_id={} error={}", session_id, exc)
            return None

    def _remember_message(self, session_id: str, occurred_at: str) -> None:
        self._last_message_at[session_id] = occurred_at
        self._last_message_at.move_to_end(session_id)
        while len(self._last_message_at) > _MAX_TRACKED_SESSIONS:
            self._last_message_at.popitem(last=False)


class NullUsageRecorder:
    """Recorder used when statistics are not wired (benchmarks, unit tests)."""

    buffered = False

    async def start(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def flush(self) -> None:
        return None

    async def record(self, event: UsageEvent) -> None:
        return None

    async def touch_user(self, user_id: str, *, occurred_at: str | None = None) -> bool:
        return False

    async def touch_session_view(
        self, session: SessionView, *, user_id: str, occurred_at: str | None = None
    ) -> bool:
        return False

    async def last_message_sent_at(self, session_id: str) -> str | None:
        return None


def _admit(
    seen: OrderedDict[Any, float],
    key: Any,
    *,
    interval_seconds: float,
    max_entries: int,
) -> bool:
    """Admit ``key`` unless it was admitted less than ``interval_seconds`` ago."""

    now = time.monotonic()
    last = seen.get(key)
    if last is not None and now - last < interval_seconds:
        return False
    seen[key] = now
    seen.move_to_end(key)
    while len(seen) > max_entries:
        seen.popitem(last=False)
    return True


# --- event builders ---------------------------------------------------------


def session_created_event(
    session: SessionView, *, user_id: str, occurred_at: str | None = None
) -> UsageEvent:
    return UsageEvent(
        EVENT_SESSION_CREATED,
        occurred_at or utc_now(),
        user_id=user_id,
        connector_id=session.connectorId,
        session_id=session.id,
        runtime_type=session.runtime,
        runtime_id=session.runtimeId,
        dedupe_key=f"session:{session.id}",
    )


def session_viewed_event(
    session: SessionView, *, user_id: str, occurred_at: str | None = None
) -> UsageEvent:
    return UsageEvent(
        EVENT_SESSION_VIEWED,
        occurred_at or utc_now(),
        user_id=user_id,
        connector_id=session.connectorId,
        session_id=session.id,
        runtime_type=session.runtime,
        runtime_id=session.runtimeId,
    )


def message_sent_event(
    session: SessionView,
    *,
    user_id: str,
    client_message_id: str | None,
    occurred_at: str | None = None,
) -> UsageEvent:
    return UsageEvent(
        EVENT_MESSAGE_SENT,
        occurred_at or utc_now(),
        user_id=user_id,
        connector_id=session.connectorId,
        session_id=session.id,
        runtime_type=session.runtime,
        runtime_id=session.runtimeId,
        dedupe_key=f"msg:{client_message_id}" if client_message_id else None,
    )


def turn_ended_event(
    session: SessionView,
    *,
    outcome: str,
    turn_id: str | None,
    started_at: str | None,
    occurred_at: str | None = None,
) -> UsageEvent:
    ended_at = occurred_at or utc_now()
    return UsageEvent(
        EVENT_TURN_ENDED,
        ended_at,
        connector_id=session.connectorId,
        session_id=session.id,
        runtime_type=session.runtime,
        runtime_id=session.runtimeId,
        outcome=outcome,
        duration_ms=_duration_ms(started_at, ended_at, max_ms=MAX_TURN_DURATION_MS),
        dedupe_key=f"turn:{session.id}:{turn_id}" if turn_id else None,
    )


def approval_event(
    notice: NoticeIn,
    *,
    connector_id: str,
    runtime_type: str | None,
    runtime_id: str | None,
) -> UsageEvent | None:
    """Map an interaction notice to a request or resolution event, if any."""

    if notice.type != "interaction" or notice.interactionType != "approval":
        return None
    if notice.status == "open":
        return UsageEvent(
            EVENT_APPROVAL_REQUESTED,
            notice.createdAt or utc_now(),
            connector_id=connector_id,
            session_id=notice.sessionId,
            runtime_type=runtime_type,
            runtime_id=runtime_id,
            dedupe_key=f"approval:{notice.noticeId}:requested",
        )
    if notice.status in APPROVAL_RESOLVED_STATUSES:
        resolved_at = notice.resolvedAt or utc_now()
        return UsageEvent(
            EVENT_APPROVAL_RESOLVED,
            resolved_at,
            connector_id=connector_id,
            session_id=notice.sessionId,
            runtime_type=runtime_type,
            runtime_id=runtime_id,
            outcome=notice.status,
            duration_ms=_duration_ms(notice.createdAt, resolved_at),
            dedupe_key=f"approval:{notice.noticeId}:resolved",
        )
    return None


def runtime_error_event(
    *,
    notice_id: str,
    session_id: str,
    connector_id: str,
    runtime_type: str | None,
    runtime_id: str | None,
    occurred_at: str | None = None,
) -> UsageEvent:
    return UsageEvent(
        EVENT_RUNTIME_ERROR,
        occurred_at or utc_now(),
        connector_id=connector_id,
        session_id=session_id,
        runtime_type=runtime_type,
        runtime_id=runtime_id,
        dedupe_key=f"rterr:{notice_id}",
    )


def connector_online_event(
    *,
    connector_id: str,
    user_id: str | None,
    device_os: str | None,
    occurred_at: str | None = None,
) -> UsageEvent:
    return UsageEvent(
        EVENT_CONNECTOR_ONLINE,
        occurred_at or utc_now(),
        user_id=user_id,
        connector_id=connector_id,
        device_os=device_os,
    )


def _duration_ms(
    started_at: str | None, ended_at: str, *, max_ms: int | None = None
) -> int | None:
    if not started_at:
        return None
    try:
        start = _parse_iso(started_at)
        end = _parse_iso(ended_at)
    except ValueError:
        return None
    delta = (end - start).total_seconds() * 1000
    if delta < 0 or (max_ms is not None and delta > max_ms):
        return None
    return int(delta)


def _parse_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed
