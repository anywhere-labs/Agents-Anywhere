from __future__ import annotations

import json
import secrets
from typing import Any

from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncConnection

from agent_server.core.models import AttachmentRef, SessionQueuedMessage
from agent_server.core.utc import utc_now
from agent_server.infra.db import session_active_runs as active_runs_t
from agent_server.infra.db import session_message_queue as message_queue_t
from agent_server.infra.db import sessions as sessions_t
from agent_server.infra.db.engine import SQLITE_BACKEND


ACTIVE_QUEUE_STATUSES = ("queued", "dispatching", "failed")


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_loads(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def _queued_message_from_row(row: Any) -> SessionQueuedMessage:
    raw_attachments = _json_loads(row["attachments_json"], [])
    raw_selections = _json_loads(row["selections_json"], {})
    raw_error = _json_loads(row["last_error_json"], None)
    return SessionQueuedMessage(
        id=row["id"],
        sessionId=row["session_id"],
        clientMessageId=row["client_message_id"],
        content=row["content"],
        attachments=[
            AttachmentRef.model_validate(value)
            for value in raw_attachments
            if isinstance(value, dict)
        ],
        selections=raw_selections if isinstance(raw_selections, dict) else {},
        status=row["status"],
        position=int(row["position"]),
        attemptCount=int(row["attempt_count"] or 0),
        lastError=raw_error if isinstance(raw_error, dict) else None,
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


class MessageQueueRepositoryMixin:
    async def enqueue_session_message(
        self,
        *,
        session_id: str,
        user_id: str,
        client_message_id: str,
        content: str,
        attachments: list[AttachmentRef],
        selections: dict[str, str | None],
    ) -> tuple[SessionQueuedMessage, bool]:
        async with self._timeline_lock(session_id):
            async with self._engine.begin() as conn:
                existing = (
                    await conn.execute(
                        select(message_queue_t).where(
                            message_queue_t.c.session_id == session_id,
                            message_queue_t.c.client_message_id == client_message_id,
                        )
                    )
                ).mappings().first()
                if existing is not None:
                    return _queued_message_from_row(existing), False

                updated_seq = await self._mark_message_queue_changed(
                    conn,
                    session_id,
                    touch_sort=True,
                )
                max_position = (
                    await conn.execute(
                        select(func.max(message_queue_t.c.position)).where(
                            message_queue_t.c.session_id == session_id
                        )
                    )
                ).scalar_one_or_none()
                now = utc_now()
                values = {
                    "id": f"qmsg_{secrets.token_urlsafe(16)}",
                    "session_id": session_id,
                    "user_id": user_id,
                    "client_message_id": client_message_id,
                    "content": content,
                    "attachments_json": _json_dumps(
                        [item.model_dump(mode="json") for item in attachments]
                    ),
                    "selections_json": _json_dumps(selections),
                    "status": "queued",
                    "position": int(max_position or 0) + 1,
                    "attempt_count": 0,
                    "last_error_json": None,
                    "claimed_at": None,
                    "dispatched_at": None,
                    "updated_seq": updated_seq,
                    "created_at": now,
                    "updated_at": now,
                }
                await conn.execute(insert(message_queue_t).values(**values))
                return _queued_message_from_row(values), True

    async def list_session_message_queue(
        self,
        session_id: str,
    ) -> list[SessionQueuedMessage]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(message_queue_t)
                    .where(
                        message_queue_t.c.session_id == session_id,
                        message_queue_t.c.status.in_(ACTIVE_QUEUE_STATUSES),
                    )
                    .order_by(message_queue_t.c.position, message_queue_t.c.created_at)
                )
            ).mappings().all()
        return [_queued_message_from_row(row) for row in rows]

    async def get_session_queue_message(
        self,
        session_id: str,
        message_id: str,
    ) -> SessionQueuedMessage:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(message_queue_t).where(
                        message_queue_t.c.session_id == session_id,
                        message_queue_t.c.id == message_id,
                    )
                )
            ).mappings().first()
        if row is None:
            raise KeyError(message_id)
        return _queued_message_from_row(row)

    async def get_message_queue_updated_seq(self, session_id: str) -> int:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(sessions_t.c.message_queue_updated_seq).where(
                        sessions_t.c.id == session_id
                    )
                )
            ).first()
        if row is None:
            raise KeyError(session_id)
        return int(row[0] or 0)

    async def cancel_session_queue_message(
        self,
        session_id: str,
        message_id: str,
    ) -> SessionQueuedMessage:
        return await self._set_queue_message_status(
            session_id,
            message_id,
            allowed_statuses=("queued", "failed"),
            status="cancelled",
        )

    async def retry_session_queue_message(
        self,
        session_id: str,
        message_id: str,
    ) -> SessionQueuedMessage:
        return await self._set_queue_message_status(
            session_id,
            message_id,
            allowed_statuses=("failed",),
            status="queued",
            clear_error=True,
        )

    async def promote_session_queue_message(
        self,
        session_id: str,
        message_id: str,
    ) -> SessionQueuedMessage:
        async with self._timeline_lock(session_id):
            async with self._engine.begin() as conn:
                row = await self._queue_row_for_update(conn, session_id, message_id)
                if row is None or row["status"] not in {"queued", "failed"}:
                    raise KeyError(message_id)
                min_position = (
                    await conn.execute(
                        select(func.min(message_queue_t.c.position)).where(
                            message_queue_t.c.session_id == session_id,
                            message_queue_t.c.status.in_(ACTIVE_QUEUE_STATUSES),
                        )
                    )
                ).scalar_one_or_none()
                updated_seq = await self._mark_message_queue_changed(conn, session_id)
                values = {
                    "position": int(min_position or 0) - 1,
                    "updated_at": utc_now(),
                    "updated_seq": updated_seq,
                }
                await conn.execute(
                    update(message_queue_t)
                    .where(message_queue_t.c.id == message_id)
                    .values(**values)
                )
                return _queued_message_from_row({**dict(row), **values})

    async def claim_next_session_queue_message(
        self,
        session_id: str,
    ) -> SessionQueuedMessage | None:
        async with self._timeline_lock(session_id):
            async with self._engine.begin() as conn:
                active_run = (
                    await conn.execute(
                        select(active_runs_t.c.session_id).where(
                            active_runs_t.c.session_id == session_id
                        )
                    )
                ).first()
                if active_run is not None:
                    return None
                dispatching = (
                    await conn.execute(
                        select(message_queue_t.c.id).where(
                            message_queue_t.c.session_id == session_id,
                            message_queue_t.c.status == "dispatching",
                        )
                    )
                ).first()
                if dispatching is not None:
                    return None
                statement = (
                    select(message_queue_t)
                    .where(
                        message_queue_t.c.session_id == session_id,
                        message_queue_t.c.status == "queued",
                    )
                    .order_by(message_queue_t.c.position, message_queue_t.c.created_at)
                    .limit(1)
                )
                if self.backend != SQLITE_BACKEND:
                    statement = statement.with_for_update(skip_locked=True)
                row = (await conn.execute(statement)).mappings().first()
                if row is None:
                    return None
                updated_seq = await self._mark_message_queue_changed(conn, session_id)
                now = utc_now()
                values = {
                    "status": "dispatching",
                    "attempt_count": int(row["attempt_count"] or 0) + 1,
                    "claimed_at": now,
                    "last_error_json": None,
                    "updated_at": now,
                    "updated_seq": updated_seq,
                }
                result = await conn.execute(
                    update(message_queue_t)
                    .where(
                        message_queue_t.c.id == row["id"],
                        message_queue_t.c.status == "queued",
                    )
                    .values(**values)
                )
                if result.rowcount != 1:
                    return None
                return _queued_message_from_row({**dict(row), **values})

    async def claim_specific_session_queue_message(
        self,
        session_id: str,
        message_id: str,
    ) -> SessionQueuedMessage:
        async with self._timeline_lock(session_id):
            async with self._engine.begin() as conn:
                dispatching = (
                    await conn.execute(
                        select(message_queue_t.c.id).where(
                            message_queue_t.c.session_id == session_id,
                            message_queue_t.c.status == "dispatching",
                        )
                    )
                ).first()
                if dispatching is not None:
                    raise KeyError(message_id)
                row = await self._queue_row_for_update(conn, session_id, message_id)
                if row is None or row["status"] not in {"queued", "failed"}:
                    raise KeyError(message_id)
                updated_seq = await self._mark_message_queue_changed(conn, session_id)
                now = utc_now()
                values = {
                    "status": "dispatching",
                    "attempt_count": int(row["attempt_count"] or 0) + 1,
                    "claimed_at": now,
                    "last_error_json": None,
                    "updated_at": now,
                    "updated_seq": updated_seq,
                }
                await conn.execute(
                    update(message_queue_t)
                    .where(message_queue_t.c.id == message_id)
                    .values(**values)
                )
                return _queued_message_from_row({**dict(row), **values})

    async def complete_session_queue_message(
        self,
        session_id: str,
        message_id: str,
    ) -> SessionQueuedMessage:
        return await self._set_queue_message_status(
            session_id,
            message_id,
            allowed_statuses=("dispatching",),
            status="dispatched",
            dispatched=True,
        )

    async def fail_session_queue_message(
        self,
        session_id: str,
        message_id: str,
        error: dict[str, Any],
        *,
        retryable: bool,
    ) -> SessionQueuedMessage:
        return await self._set_queue_message_status(
            session_id,
            message_id,
            allowed_statuses=("dispatching",),
            status="queued" if retryable else "failed",
            error=error,
        )

    async def list_sessions_with_queued_messages(self) -> list[str]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(message_queue_t.c.session_id)
                    .where(message_queue_t.c.status == "queued")
                    .distinct()
                )
            ).all()
        return [str(row[0]) for row in rows]

    async def _set_queue_message_status(
        self,
        session_id: str,
        message_id: str,
        *,
        allowed_statuses: tuple[str, ...],
        status: str,
        error: dict[str, Any] | None = None,
        clear_error: bool = False,
        dispatched: bool = False,
    ) -> SessionQueuedMessage:
        async with self._timeline_lock(session_id):
            async with self._engine.begin() as conn:
                row = await self._queue_row_for_update(conn, session_id, message_id)
                if row is None or row["status"] not in set(allowed_statuses):
                    raise KeyError(message_id)
                updated_seq = await self._mark_message_queue_changed(conn, session_id)
                now = utc_now()
                values: dict[str, Any] = {
                    "status": status,
                    "claimed_at": None,
                    "updated_at": now,
                    "updated_seq": updated_seq,
                }
                if error is not None:
                    values["last_error_json"] = _json_dumps(error)
                elif clear_error or dispatched:
                    values["last_error_json"] = None
                if dispatched:
                    values["dispatched_at"] = now
                await conn.execute(
                    update(message_queue_t)
                    .where(message_queue_t.c.id == message_id)
                    .values(**values)
                )
                return _queued_message_from_row({**dict(row), **values})

    async def _queue_row_for_update(
        self,
        conn: AsyncConnection,
        session_id: str,
        message_id: str,
    ) -> Any | None:
        statement = select(message_queue_t).where(
            message_queue_t.c.session_id == session_id,
            message_queue_t.c.id == message_id,
        )
        if self.backend != SQLITE_BACKEND:
            statement = statement.with_for_update()
        return (await conn.execute(statement)).mappings().first()

    async def _mark_message_queue_changed(
        self,
        conn: AsyncConnection,
        session_id: str,
        *,
        touch_sort: bool = False,
    ) -> int:
        updated_seq = await self._bump_session(conn, session_id)
        values: dict[str, Any] = {"message_queue_updated_seq": updated_seq}
        if touch_sort:
            values["sort_at"] = utc_now()
        await conn.execute(
            update(sessions_t)
            .where(sessions_t.c.id == session_id)
            .values(**values)
        )
        return updated_seq
