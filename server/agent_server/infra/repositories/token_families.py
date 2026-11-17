"""Login token families (``05-server.md`` §8).

One row per login. The refresh token is stored as a SHA-256 hash, and so is the
one it replaced: presenting that previous token again means it was copied, and
the whole family is revoked.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select, update

from agent_server.core.utc import utc_now
from agent_server.infra.db.engine import read_connection
from agent_server.infra.db.schema import user_token_families, users


def _family_view(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "client": row["client"],
        "refreshExpiresAt": row["refresh_expires_at"],
        "createdAt": row["created_at"],
        "lastUsedAt": row["last_used_at"],
        "revokedAt": row["revoked_at"],
        "revokedReason": row["revoked_reason"],
    }


class TokenFamilyRepositoryMixin:
    _engine: Any

    async def create_token_family(
        self, *, family_id: str, user_id: str, client: str, refresh_hash: str, refresh_expires_at: str
    ) -> dict[str, Any]:
        now = utc_now()
        values = {
            "id": family_id,
            "user_id": user_id,
            "client": client,
            "refresh_hash": refresh_hash,
            "previous_refresh_hash": None,
            "refresh_expires_at": refresh_expires_at,
            "created_at": now,
            "last_used_at": now,
            "revoked_at": None,
            "revoked_reason": None,
        }
        async with self._engine.begin() as conn:
            await conn.execute(user_token_families.insert().values(**values))
        return _family_view(values)

    async def rotate_token_family(
        self, family_id: str, *, presented_hash: str, new_hash: str, refresh_expires_at: str
    ) -> tuple[str, dict[str, Any] | None]:
        """``("rotated", family)``; ``("reused", family)`` after revoking it; ``("invalid", None)``.

        A presented token that matches neither the current nor the previous hash, or a
        family that is revoked or expired, is ``invalid`` and changes nothing.
        """

        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(user_token_families).where(user_token_families.c.id == family_id).with_for_update()
                )
            ).mappings().first()
            if row is None or row["revoked_at"] is not None or row["refresh_expires_at"] <= now:
                return "invalid", None
            if row["refresh_hash"] == presented_hash:
                await conn.execute(
                    update(user_token_families)
                    .where(user_token_families.c.id == family_id)
                    .values(
                        refresh_hash=new_hash,
                        previous_refresh_hash=presented_hash,
                        refresh_expires_at=refresh_expires_at,
                        last_used_at=now,
                    )
                )
                return "rotated", _family_view({**row, "refresh_expires_at": refresh_expires_at, "last_used_at": now})
            if row["previous_refresh_hash"] == presented_hash:
                await conn.execute(
                    update(user_token_families)
                    .where(user_token_families.c.id == family_id)
                    .values(revoked_at=now, revoked_reason="refresh_reused", refresh_hash=None)
                )
                return "reused", _family_view({**row, "revoked_at": now, "revoked_reason": "refresh_reused"})
            return "invalid", None

    async def touch_token_family(self, family_id: str) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(user_token_families)
                .where(user_token_families.c.id == family_id)
                .values(last_used_at=utc_now())
            )

    async def revoke_token_family(self, family_id: str, *, user_id: str, reason: str) -> bool:
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(user_token_families)
                .where(
                    user_token_families.c.id == family_id,
                    user_token_families.c.user_id == user_id,
                    user_token_families.c.revoked_at.is_(None),
                )
                .values(revoked_at=utc_now(), revoked_reason=reason, refresh_hash=None)
            )
        return bool(result.rowcount)

    async def revoke_user_token_families(self, user_id: str, *, reason: str, keep: str | None = None) -> int:
        conditions = [user_token_families.c.user_id == user_id, user_token_families.c.revoked_at.is_(None)]
        if keep is not None:
            conditions.append(user_token_families.c.id != keep)
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(user_token_families)
                .where(*conditions)
                .values(revoked_at=utc_now(), revoked_reason=reason, refresh_hash=None)
            )
        return int(result.rowcount or 0)

    async def token_family_status(self, user_id: str, family_id: str | None) -> bool:
        """Whether a token of ``user_id`` (in ``family_id``, when it has one) may still be used."""

        async with read_connection(self._engine) as conn:
            user = (
                await conn.execute(select(users.c.disabled).where(users.c.id == user_id))
            ).first()
            if user is None or user.disabled:
                return False
            if family_id is None:
                return True
            row = (
                await conn.execute(
                    select(user_token_families.c.user_id, user_token_families.c.revoked_at).where(
                        user_token_families.c.id == family_id
                    )
                )
            ).first()
        return row is not None and row.user_id == user_id and row.revoked_at is None

    async def list_token_families(self, user_id: str) -> list[dict[str, Any]]:
        async with read_connection(self._engine) as conn:
            rows = (
                await conn.execute(
                    select(user_token_families)
                    .where(user_token_families.c.user_id == user_id)
                    .order_by(user_token_families.c.last_used_at.desc())
                )
            ).mappings().all()
        return [_family_view(row) for row in rows]
