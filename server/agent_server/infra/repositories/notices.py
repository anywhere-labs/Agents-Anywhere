# ruff: noqa: F403, F405, I001

from __future__ import annotations

from agent_server.infra.repositories.store_support import *

OPEN_NOTICE_STATUSES = {"open", "response_accepted", "resolving", "failed"}


class NoticeRepositoryMixin:
    async def upsert_notice(self, notice: NoticeIn) -> Notice:
        now = utc_now()
        async with self._engine.begin() as conn:
            existing = (
                await conn.execute(
                    select(notices_t.c.id).where(
                        notices_t.c.id == notice.noticeId,
                        notices_t.c.session_id == notice.sessionId,
                    )
                )
            ).first()
            updated_seq = await self._bump_session(conn, notice.sessionId)
            values = _notice_values(notice, updated_seq=updated_seq, now=now)
            if existing is None:
                await conn.execute(insert(notices_t).values(**values))
            else:
                values.pop("created_at", None)
                await conn.execute(
                    update(notices_t)
                    .where(
                        notices_t.c.id == notice.noticeId,
                        notices_t.c.session_id == notice.sessionId,
                    )
                    .values(**values)
                )
        await self.refresh_session_status_from_timeline(notice.sessionId)
        return await self.get_notice(notice.noticeId)

    async def get_notice(self, notice_id: str) -> Notice:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(select(notices_t).where(notices_t.c.id == notice_id))
            ).mappings().first()
        if row is None:
            raise KeyError(notice_id)
        return _notice_from_row(row)

    async def list_open_notices(self, session_id: str) -> list[Notice]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(notices_t)
                    .where(
                        notices_t.c.session_id == session_id,
                        notices_t.c.status.in_(tuple(OPEN_NOTICE_STATUSES)),
                    )
                    .order_by(notices_t.c.updated_seq.asc())
                )
            ).mappings().all()
        return [_notice_from_row(row) for row in rows]

    async def list_notices_since(self, session_id: str, after_seq: int) -> list[Notice]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(notices_t)
                    .where(
                        notices_t.c.session_id == session_id,
                        notices_t.c.updated_seq > after_seq,
                    )
                    .order_by(notices_t.c.updated_seq.asc())
                )
            ).mappings().all()
        return [_notice_from_row(row) for row in rows]

    async def list_open_blocking_notices(self, session_id: str) -> list[Notice]:
        return [
            notice
            for notice in await self.list_open_notices(session_id)
            if notice.blocking is not None
            and notice.blocking.scope == "session"
            and notice.blocking.targetId == session_id
        ]

    async def update_notice_status(
        self,
        notice_id: str,
        status: str,
        *,
        expected_status: str | None = None,
        context_patch: dict[str, Any] | None = None,
    ) -> Notice:
        now = utc_now()
        async with self._engine.begin() as conn:
            statement = select(notices_t).where(notices_t.c.id == notice_id)
            if expected_status is not None:
                statement = statement.with_for_update()
            row = (
                await conn.execute(statement)
            ).mappings().first()
            if row is None:
                raise KeyError(notice_id)
            if expected_status is not None and row["status"] != expected_status:
                raise ValueError("interaction status changed")
            context = _json_loads(row["context_json"]) or {}
            if context_patch:
                context = {**context, **context_patch}
            updated_seq = await self._bump_session(conn, row["session_id"])
            update_statement = update(notices_t).where(notices_t.c.id == notice_id)
            if expected_status is not None:
                update_statement = update_statement.where(
                    notices_t.c.status == expected_status
                )
            result = await conn.execute(
                update_statement
                .values(
                    status=status,
                    context_json=_json_dumps(context),
                    revision=int(row["revision"] or 1) + 1,
                    updated_seq=updated_seq,
                    updated_at=now,
                    resolved_at=now
                    if status in {"resolved", "expired", "cancelled"}
                    else None,
                )
            )
            if result.rowcount != 1:
                raise ValueError("interaction status changed")
            session_id = row["session_id"]
        await self.refresh_session_status_from_timeline(session_id)
        return await self.get_notice(notice_id)

def _notice_values(notice: NoticeIn, *, updated_seq: int, now: str) -> dict[str, Any]:
    return {
        "id": notice.noticeId,
        "session_id": notice.sessionId,
        "type": notice.type,
        "status": notice.status,
        "interaction_type": notice.interactionType,
        "blocking_json": _json_dumps(notice.blocking.model_dump(mode="json"))
        if notice.blocking is not None
        else None,
        "response_required": 1 if notice.responseRequired else 0,
        "severity": notice.severity,
        "title": notice.title,
        "message": notice.message,
        "source_json": _json_dumps(notice.source.model_dump(mode="json", exclude_none=True)),
        "actions_json": _json_dumps([action.model_dump(mode="json", by_alias=True) for action in notice.actions]),
        "context_json": _json_dumps(notice.context),
        "metadata_json": _json_dumps(notice.metadata),
        "revision": notice.revision,
        "updated_seq": updated_seq,
        "created_at": notice.createdAt or now,
        "updated_at": now,
        "expires_at": notice.expiresAt,
        "resolved_at": notice.resolvedAt,
    }


def _notice_from_row(row: Any) -> Notice:
    return Notice(
        noticeId=row["id"],
        sessionId=row["session_id"],
        type=row["type"],
        status=row["status"],
        interactionType=row["interaction_type"],
        blocking=_json_loads(row["blocking_json"]),
        responseRequired=bool(row["response_required"]),
        severity=row["severity"],
        title=row["title"],
        message=row["message"],
        source=_json_loads(row["source_json"]) or {},
        actions=_json_loads(row["actions_json"]) or [],
        context=_json_loads(row["context_json"]) or {},
        metadata=_json_loads(row["metadata_json"]) or {},
        revision=row["revision"],
        updatedSeq=row["updated_seq"],
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
        expiresAt=row["expires_at"],
        resolvedAt=row["resolved_at"],
    )
