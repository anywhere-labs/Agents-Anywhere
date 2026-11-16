"""Persistence for the server-owned per-session message queue.

Every change runs in one transaction that first locks the session's
``session_queue_state`` row, so changes to one session's queue are serialized
across workers, and bumps that row's revision for clients to order snapshots.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncConnection

from agent_server.core.message_queue import (
    MESSAGE_QUEUE_MAX_ITEMS,
    QueueFullError,
    QueueItemNotFoundError,
    QueueItemSendingError,
    QueueOrderMismatchError,
)
from agent_server.core.utc import utc_now
from agent_server.infra.db.engine import read_connection
from agent_server.infra.db.schema import (
    session_queue_state,
    session_queued_messages,
    sessions,
)

_POSITION_STEP = 1024
_items = session_queued_messages
_state = session_queue_state


def _encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _item_view(row: Any, position: int) -> dict[str, Any]:
    error = json.loads(row["error_json"]) if row["error_json"] else None
    return {
        "messageId": row["id"],
        "sessionId": row["session_id"],
        "clientMessageId": row["client_message_id"],
        "content": row["content"],
        "attachments": json.loads(row["attachments_json"] or "[]"),
        "status": row["status"],
        "position": position,
        "interruptRequested": bool(row["interrupt_requested"]),
        "createdBy": row["created_by"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "error": error,
    }


def _dispatch_row(row: Any) -> dict[str, Any]:
    return {
        "messageId": row["id"],
        "sessionId": row["session_id"],
        "clientMessageId": row["client_message_id"],
        "content": row["content"],
        "attachments": json.loads(row["attachments_json"] or "[]"),
        "status": row["status"],
        "interruptRequested": bool(row["interrupt_requested"]),
        "interruptAttemptedAt": row["interrupt_attempted_at"],
        "resumeRequested": bool(row["resume_requested"]),
        "createdBy": row["created_by"],
        "claimOwner": row["claim_owner"],
    }


class MessageQueueRepositoryMixin:
    # -- reads ---------------------------------------------------------------

    async def get_session_queue(self, session_id: str) -> dict[str, Any]:
        async with read_connection(self._engine) as conn:
            return await self._queue_snapshot(conn, session_id)

    async def session_queue_has_items(self, session_id: str) -> bool:
        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(
                    select(_items.c.id).where(_items.c.session_id == session_id).limit(1)
                )
            ).first()
        return row is not None

    async def session_queue_revision(self, session_id: str) -> int:
        async with read_connection(self._engine) as conn:
            value = (
                await conn.execute(
                    select(_state.c.revision).where(_state.c.session_id == session_id)
                )
            ).scalar_one_or_none()
        return int(value or 0)

    async def get_session_queue_head(self, session_id: str) -> dict[str, Any] | None:
        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(
                    select(_items)
                    .where(_items.c.session_id == session_id)
                    .order_by(_items.c.position, _items.c.created_at)
                    .limit(1)
                )
            ).mappings().first()
        return _dispatch_row(row) if row is not None else None

    async def list_sessions_with_queued_messages(
        self,
        *,
        connector_id: str | None = None,
        limit: int = 500,
    ) -> list[str]:
        query = select(_items.c.session_id).distinct()
        if connector_id is not None:
            query = query.join(sessions, sessions.c.id == _items.c.session_id).where(
                sessions.c.connector_id == connector_id
            )
        async with read_connection(self._engine) as conn:
            rows = (await conn.execute(query.limit(limit))).scalars().all()
        return list(rows)

    # -- client changes ------------------------------------------------------

    async def enqueue_session_message(
        self,
        session_id: str,
        *,
        user_id: str,
        client_message_id: str,
        content: str,
        attachments: list[dict[str, Any]],
        at_head: bool = False,
        interrupt: bool = False,
    ) -> tuple[dict[str, Any], dict[str, Any], bool]:
        """Append (or, with ``at_head``, prepend) a message.

        Returns ``(item, queue, created)``. The same ``client_message_id`` for
        the session returns the existing item with ``created`` false.
        """
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            existing = (
                await conn.execute(
                    select(_items).where(
                        _items.c.session_id == session_id,
                        _items.c.client_message_id == client_message_id,
                    )
                )
            ).mappings().first()
            if existing is not None:
                queue = await self._queue_snapshot(conn, session_id)
                return self._find_item(queue, existing["id"]), queue, False
            count, low, high = (
                await conn.execute(
                    select(
                        func.count(),
                        func.min(_items.c.position),
                        func.max(_items.c.position),
                    ).where(_items.c.session_id == session_id)
                )
            ).one()
            if int(count or 0) >= MESSAGE_QUEUE_MAX_ITEMS:
                raise QueueFullError(
                    f"at most {MESSAGE_QUEUE_MAX_ITEMS} messages can wait in a session queue"
                )
            if at_head:
                position = await self._head_position(conn, session_id, low)
            else:
                position = (int(high) + _POSITION_STEP) if high is not None else 0
            now = utc_now()
            message_id = f"qmsg_{uuid4().hex}"
            await conn.execute(
                insert(_items).values(
                    id=message_id,
                    session_id=session_id,
                    created_by=user_id,
                    client_message_id=client_message_id,
                    content=content,
                    attachments_json=_encode(attachments),
                    status="queued",
                    position=position,
                    interrupt_requested=interrupt,
                    resume_requested=interrupt,
                    created_at=now,
                    updated_at=now,
                )
            )
            await self._bump_queue(conn, session_id)
            queue = await self._queue_snapshot(conn, session_id)
        return self._find_item(queue, message_id), queue, True

    async def update_session_queue_item(
        self,
        session_id: str,
        message_id: str,
        *,
        content: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            await self._editable_row(conn, session_id, message_id)
            values: dict[str, Any] = {"updated_at": utc_now()}
            if content is not None:
                values["content"] = content
            if attachments is not None:
                values["attachments_json"] = _encode(attachments)
            await conn.execute(
                update(_items).where(_items.c.id == message_id).values(**values)
            )
            await self._bump_queue(conn, session_id)
            return await self._queue_snapshot(conn, session_id)

    async def delete_session_queue_item(
        self,
        session_id: str,
        message_id: str,
    ) -> dict[str, Any]:
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            await self._editable_row(conn, session_id, message_id)
            await conn.execute(delete(_items).where(_items.c.id == message_id))
            await self._bump_queue(conn, session_id)
            return await self._queue_snapshot(conn, session_id)

    async def clear_session_queue(self, session_id: str) -> dict[str, Any]:
        """Drop every message that is not already being sent."""
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            result = await conn.execute(
                delete(_items).where(
                    _items.c.session_id == session_id,
                    _items.c.status != "sending",
                )
            )
            if result.rowcount:
                await self._bump_queue(conn, session_id)
            return await self._queue_snapshot(conn, session_id)

    async def retry_session_queue_item(
        self,
        session_id: str,
        message_id: str,
    ) -> dict[str, Any]:
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            await self._editable_row(conn, session_id, message_id)
            await conn.execute(
                update(_items)
                .where(_items.c.id == message_id)
                .values(
                    status="queued",
                    error_json=None,
                    resume_requested=True,
                    claim_owner=None,
                    claimed_at=None,
                    updated_at=utc_now(),
                )
            )
            await self._bump_queue(conn, session_id)
            return await self._queue_snapshot(conn, session_id)

    async def send_session_queue_item_now(
        self,
        session_id: str,
        message_id: str,
    ) -> dict[str, Any]:
        """Move a message to the head and ask for the current turn to stop."""
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            await self._editable_row(conn, session_id, message_id)
            low = (
                await conn.execute(
                    select(func.min(_items.c.position)).where(
                        _items.c.session_id == session_id,
                        _items.c.id != message_id,
                    )
                )
            ).scalar_one_or_none()
            position = await self._head_position(conn, session_id, low, exclude=message_id)
            await conn.execute(
                update(_items)
                .where(_items.c.id == message_id)
                .values(
                    position=position,
                    status="queued",
                    error_json=None,
                    interrupt_requested=True,
                    interrupt_attempted_at=None,
                    resume_requested=True,
                    updated_at=utc_now(),
                )
            )
            await self._bump_queue(conn, session_id)
            return await self._queue_snapshot(conn, session_id)

    async def resume_session_queue(self, session_id: str) -> dict[str, Any]:
        """Let the head go out although the last turn ended in an error."""
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            head = (
                await conn.execute(
                    select(_items)
                    .where(_items.c.session_id == session_id)
                    .order_by(_items.c.position, _items.c.created_at)
                    .limit(1)
                )
            ).mappings().first()
            if head is not None and head["status"] == "queued":
                await conn.execute(
                    update(_items)
                    .where(_items.c.id == head["id"])
                    .values(resume_requested=True, updated_at=utc_now())
                )
                await self._bump_queue(conn, session_id)
            return await self._queue_snapshot(conn, session_id)

    async def reorder_session_queue(
        self,
        session_id: str,
        message_ids: list[str],
    ) -> dict[str, Any]:
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            rows = (
                await conn.execute(
                    select(_items.c.id, _items.c.status)
                    .where(_items.c.session_id == session_id)
                    .order_by(_items.c.position, _items.c.created_at)
                )
            ).all()
            current = [row.id for row in rows]
            if sorted(current) != sorted(message_ids) or len(set(message_ids)) != len(message_ids):
                raise QueueOrderMismatchError("the order must list every queued message once")
            sending = [row.id for row in rows if row.status == "sending"]
            if sending and message_ids[0] != sending[0]:
                raise QueueItemSendingError("the message being sent stays first")
            now = utc_now()
            for index, message_id in enumerate(message_ids):
                await conn.execute(
                    update(_items)
                    .where(_items.c.id == message_id)
                    .values(position=index * _POSITION_STEP, updated_at=now)
                )
            await self._bump_queue(conn, session_id)
            return await self._queue_snapshot(conn, session_id)

    # -- dispatcher ----------------------------------------------------------

    async def claim_session_queue_head(
        self,
        session_id: str,
        message_id: str,
        *,
        owner: str,
    ) -> dict[str, Any] | None:
        """``queued`` -> ``sending`` for the current head only."""
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            head = (
                await conn.execute(
                    select(_items)
                    .where(_items.c.session_id == session_id)
                    .order_by(_items.c.position, _items.c.created_at)
                    .limit(1)
                )
            ).mappings().first()
            if head is None or head["id"] != message_id or head["status"] != "queued":
                return None
            now = utc_now()
            await conn.execute(
                update(_items)
                .where(_items.c.id == message_id)
                .values(status="sending", claim_owner=owner, claimed_at=now, updated_at=now)
            )
            await self._bump_queue(conn, session_id)
            row = (
                await conn.execute(select(_items).where(_items.c.id == message_id))
            ).mappings().one()
            return _dispatch_row(row)

    async def finish_session_queue_item(
        self,
        session_id: str,
        message_id: str,
        *,
        owner: str,
    ) -> bool:
        """Remove a message the runtime accepted."""
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            result = await conn.execute(
                delete(_items).where(
                    _items.c.id == message_id,
                    _items.c.claim_owner == owner,
                )
            )
            if result.rowcount:
                await self._bump_queue(conn, session_id)
            return bool(result.rowcount)

    async def fail_session_queue_item(
        self,
        session_id: str,
        message_id: str,
        *,
        code: str,
        message: str,
        owner: str | None = None,
    ) -> bool:
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            condition = [_items.c.id == message_id]
            if owner is not None:
                condition.append(_items.c.claim_owner == owner)
            result = await conn.execute(
                update(_items)
                .where(*condition)
                .values(
                    status="failed",
                    error_json=_encode({"code": code, "message": message}),
                    claim_owner=None,
                    claimed_at=None,
                    interrupt_requested=False,
                    resume_requested=False,
                    updated_at=utc_now(),
                )
            )
            if result.rowcount:
                await self._bump_queue(conn, session_id)
            return bool(result.rowcount)

    async def mark_session_queue_interrupt_attempted(
        self,
        session_id: str,
        message_id: str,
    ) -> bool:
        """Record one interrupt per head; returns false if already attempted."""
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            result = await conn.execute(
                update(_items)
                .where(
                    _items.c.id == message_id,
                    _items.c.interrupt_attempted_at.is_(None),
                )
                .values(interrupt_attempted_at=utc_now())
            )
        return bool(result.rowcount)

    async def cancel_session_queue_interrupt(
        self,
        session_id: str,
        message_id: str,
    ) -> dict[str, Any]:
        """The turn could not be stopped: keep the message as an ordinary entry."""
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            await conn.execute(
                update(_items)
                .where(_items.c.id == message_id)
                .values(interrupt_requested=False, updated_at=utc_now())
            )
            await self._bump_queue(conn, session_id)
            return await self._queue_snapshot(conn, session_id)

    async def fail_stale_session_queue_sends(
        self,
        *,
        older_than_seconds: float,
    ) -> list[str]:
        """Turn sends whose dispatcher vanished into failures; never resend them.

        The runtime may already have received such a message, so the user
        decides whether to retry.
        """
        deadline = (
            datetime.now(UTC) - timedelta(seconds=older_than_seconds)
        ).isoformat()
        async with read_connection(self._engine) as conn:
            rows = (
                await conn.execute(
                    select(_items.c.id, _items.c.session_id).where(
                        _items.c.status == "sending",
                        _items.c.claimed_at < deadline,
                    )
                )
            ).all()
        failed: list[str] = []
        for row in rows:
            if await self.fail_session_queue_item(
                row.session_id,
                row.id,
                code="queue_dispatch_unknown",
                message="The message may not have been delivered. Check the conversation, then retry or delete it.",
            ):
                failed.append(row.session_id)
        return failed

    async def release_session_queue_claim(
        self,
        session_id: str,
        message_id: str,
        *,
        owner: str,
    ) -> bool:
        """The session became busy before the send: wait again at the head."""
        async with self._engine.begin() as conn:
            await self._lock_queue(conn, session_id)
            result = await conn.execute(
                update(_items)
                .where(_items.c.id == message_id, _items.c.claim_owner == owner)
                .values(status="queued", claim_owner=None, claimed_at=None, updated_at=utc_now())
            )
            if result.rowcount:
                await self._bump_queue(conn, session_id)
            return bool(result.rowcount)

    async def renew_session_queue_claim(self, message_id: str, *, owner: str) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(_items)
                .where(_items.c.id == message_id, _items.c.claim_owner == owner)
                .values(claimed_at=utc_now())
            )

    # -- helpers -------------------------------------------------------------

    async def _lock_queue(self, conn: AsyncConnection, session_id: str) -> None:
        await conn.execute(
            pg_insert(_state)
            .values(session_id=session_id, revision=0, updated_at=utc_now())
            .on_conflict_do_nothing(index_elements=[_state.c.session_id])
        )
        await conn.execute(
            select(_state.c.revision)
            .where(_state.c.session_id == session_id)
            .with_for_update()
        )

    async def _bump_queue(self, conn: AsyncConnection, session_id: str) -> None:
        await conn.execute(
            update(_state)
            .where(_state.c.session_id == session_id)
            .values(revision=_state.c.revision + 1, updated_at=utc_now())
        )

    async def _head_position(
        self,
        conn: AsyncConnection,
        session_id: str,
        low: Any,
        *,
        exclude: str | None = None,
    ) -> int:
        """A position before every message except one already being sent."""
        query = select(func.max(_items.c.position)).where(
            _items.c.session_id == session_id,
            _items.c.status == "sending",
        )
        if exclude is not None:
            query = query.where(_items.c.id != exclude)
        sending = (await conn.execute(query)).scalar_one_or_none()
        if sending is not None:
            following = (
                await conn.execute(
                    select(func.min(_items.c.position)).where(
                        _items.c.session_id == session_id,
                        _items.c.position > sending,
                        *([_items.c.id != exclude] if exclude else []),
                    )
                )
            ).scalar_one_or_none()
            if following is None:
                return int(sending) + _POSITION_STEP
            if int(following) - int(sending) < 2:
                await self._respace(conn, session_id)
                return await self._head_position(conn, session_id, None, exclude=exclude)
            return (int(sending) + int(following)) // 2
        return (int(low) - _POSITION_STEP) if low is not None else 0

    async def _respace(self, conn: AsyncConnection, session_id: str) -> None:
        rows = (
            await conn.execute(
                select(_items.c.id)
                .where(_items.c.session_id == session_id)
                .order_by(_items.c.position, _items.c.created_at)
            )
        ).scalars().all()
        for index, message_id in enumerate(rows):
            await conn.execute(
                update(_items)
                .where(_items.c.id == message_id)
                .values(position=index * _POSITION_STEP)
            )

    async def _editable_row(
        self,
        conn: AsyncConnection,
        session_id: str,
        message_id: str,
    ) -> Any:
        row = (
            await conn.execute(
                select(_items).where(
                    _items.c.id == message_id,
                    _items.c.session_id == session_id,
                )
            )
        ).mappings().first()
        if row is None:
            raise QueueItemNotFoundError("queued message not found")
        if row["status"] == "sending":
            raise QueueItemSendingError("the message is being sent")
        return row

    async def _queue_snapshot(self, conn: AsyncConnection, session_id: str) -> dict[str, Any]:
        revision = (
            await conn.execute(
                select(_state.c.revision).where(_state.c.session_id == session_id)
            )
        ).scalar_one_or_none()
        rows = (
            await conn.execute(
                select(_items)
                .where(_items.c.session_id == session_id)
                .order_by(_items.c.position, _items.c.created_at)
            )
        ).mappings().all()
        return {
            "sessionId": session_id,
            "revision": int(revision or 0),
            "items": [_item_view(row, index + 1) for index, row in enumerate(rows)],
        }

    @staticmethod
    def _find_item(queue: dict[str, Any], message_id: str) -> dict[str, Any]:
        return next(item for item in queue["items"] if item["messageId"] == message_id)
