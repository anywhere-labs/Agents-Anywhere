"""Port previews (``contracts/preview/1.0``): one row per device port."""

from __future__ import annotations

import secrets
from typing import Any

from sqlalchemy import and_, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError

from agent_server.core.utc import utc_now
from agent_server.infra.db.engine import read_connection
from agent_server.infra.db.schema import previews

_BASE32 = "abcdefghijklmnopqrstuvwxyz234567"
OPEN_STATES = ("opening", "open")


def new_slug() -> str:
    """A random 10-character DNS label (50 bits)."""

    return "".join(secrets.choice(_BASE32) for _ in range(10))


def _view(row: Any) -> dict[str, Any]:
    return {
        "previewId": row["id"],
        "slug": row["slug"],
        "userId": row["user_id"],
        "deviceId": row["device_id"],
        "sessionId": row["session_id"],
        "port": int(row["port"]),
        "visibility": row["visibility"],
        "state": row["state"],
        "closeReason": row["close_reason"],
        "expiresAt": row["expires_at"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


class PreviewRepositoryMixin:
    _engine: Any

    async def open_preview_row(
        self,
        *,
        user_id: str,
        device_id: str,
        port: int,
        session_id: str | None,
        visibility: str,
        expires_at: str,
    ) -> dict[str, Any]:
        """Create the device port's preview, or reopen it with the same id and slug."""

        now = utc_now()
        for _ in range(5):
            statement = (
                pg_insert(previews)
                .values(
                    id=f"pv_{secrets.token_urlsafe(12)}",
                    slug=new_slug(),
                    user_id=user_id,
                    device_id=device_id,
                    session_id=session_id,
                    port=port,
                    visibility=visibility,
                    state="opening",
                    close_reason=None,
                    expires_at=expires_at,
                    created_at=now,
                    updated_at=now,
                )
                .on_conflict_do_update(
                    constraint="uq_previews_device_port",
                    set_={
                        "user_id": user_id,
                        "session_id": session_id,
                        "visibility": visibility,
                        "state": "opening",
                        "close_reason": None,
                        "expires_at": expires_at,
                        "updated_at": now,
                    },
                )
                .returning(*previews.c)
            )
            try:
                async with self._engine.begin() as conn:
                    row = (await conn.execute(statement)).mappings().one()
                return _view(row)
            except IntegrityError as exc:
                # A slug collision retries with a new slug.
                if "previews_slug_key" not in str(exc):
                    raise
        raise RuntimeError("could not allocate a preview slug")

    async def get_preview(self, preview_id: str, *, user_id: str | None = None) -> dict[str, Any]:
        query = select(previews).where(previews.c.id == preview_id)
        if user_id is not None:
            query = query.where(previews.c.user_id == user_id)
        async with read_connection(self._engine) as conn:
            row = (await conn.execute(query)).mappings().first()
        if row is None:
            raise KeyError(preview_id)
        return _view(row)

    async def get_preview_by_slug(self, slug: str) -> dict[str, Any] | None:
        async with read_connection(self._engine) as conn:
            row = (await conn.execute(select(previews).where(previews.c.slug == slug))).mappings().first()
        return _view(row) if row is not None else None

    async def list_user_previews(self, user_id: str) -> list[dict[str, Any]]:
        query = (
            select(previews)
            .where(previews.c.user_id == user_id, previews.c.state.in_(OPEN_STATES))
            .order_by(previews.c.created_at, previews.c.id)
        )
        async with read_connection(self._engine) as conn:
            return [_view(row) for row in (await conn.execute(query)).mappings().all()]

    async def count_open_device_previews(self, device_id: str, *, excluding_port: int | None = None) -> int:
        query = select(func.count()).select_from(previews).where(
            previews.c.device_id == device_id, previews.c.state.in_(OPEN_STATES)
        )
        if excluding_port is not None:
            query = query.where(previews.c.port != excluding_port)
        async with read_connection(self._engine) as conn:
            return int((await conn.execute(query)).scalar_one())

    async def set_preview_state(
        self,
        preview_id: str,
        state: str,
        *,
        reason: str | None = None,
        only_from: tuple[str, ...] = OPEN_STATES,
    ) -> dict[str, Any] | None:
        """Move a preview to ``state`` if it is in one of ``only_from``; the updated row or None."""

        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    update(previews)
                    .where(previews.c.id == preview_id, previews.c.state.in_(only_from))
                    .values(state=state, close_reason=reason, updated_at=utc_now())
                    .returning(*previews.c)
                )
            ).mappings().first()
        return _view(row) if row is not None else None

    async def open_device_previews(self, device_id: str, *, port: int | None = None) -> list[dict[str, Any]]:
        conditions = [previews.c.device_id == device_id, previews.c.state.in_(OPEN_STATES)]
        if port is not None:
            conditions.append(previews.c.port == port)
        async with read_connection(self._engine) as conn:
            rows = (await conn.execute(select(previews).where(and_(*conditions)))).mappings().all()
        return [_view(row) for row in rows]

    async def expired_previews(self, now: str) -> list[dict[str, Any]]:
        query = select(previews).where(previews.c.state.in_(OPEN_STATES), previews.c.expires_at <= now)
        async with read_connection(self._engine) as conn:
            return [_view(row) for row in (await conn.execute(query)).mappings().all()]

    async def devices_with_open_previews(self) -> list[str]:
        query = select(previews.c.device_id).where(previews.c.state.in_(OPEN_STATES)).distinct()
        async with read_connection(self._engine) as conn:
            return [str(value) for value in (await conn.execute(query)).scalars().all()]
