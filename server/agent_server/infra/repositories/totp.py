"""Durable state for authenticator-app two-step verification."""

from __future__ import annotations

from typing import Any

from sqlalchemy import delete, func, insert, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from agent_server.core.utc import utc_now
from agent_server.infra.db.engine import read_connection
from agent_server.infra.db.schema import user_totp as totp_t
from agent_server.infra.db.schema import user_totp_recovery_codes as recovery_t


class TotpRepositoryMixin:
    async def totp_record(self, user_id: str) -> dict[str, Any] | None:
        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(select(totp_t).where(totp_t.c.user_id == user_id))
            ).mappings().first()
        return dict(row) if row is not None else None

    async def save_pending_totp(self, user_id: str, secret_sealed: str) -> None:
        """Store a new unconfirmed secret, replacing an earlier unconfirmed one."""
        now = utc_now()
        async with self._engine.begin() as conn:
            current = (
                await conn.execute(
                    select(totp_t.c.enabled_at)
                    .where(totp_t.c.user_id == user_id)
                    .with_for_update()
                )
            ).first()
            if current is not None and current.enabled_at is not None:
                raise ValueError("two-step verification is already enabled")
            statement = pg_insert(totp_t).values(
                user_id=user_id,
                secret_sealed=secret_sealed,
                enabled_at=None,
                last_used_step=None,
                failed_attempts=0,
                locked_until=None,
                created_at=now,
                updated_at=now,
            )
            await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=[totp_t.c.user_id],
                    set_={
                        "secret_sealed": statement.excluded.secret_sealed,
                        "last_used_step": None,
                        "failed_attempts": 0,
                        "locked_until": None,
                        "updated_at": now,
                    },
                )
            )

    async def enable_totp(
        self, user_id: str, *, step: int, recovery_code_hashes: list[str]
    ) -> bool:
        now = utc_now()
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(totp_t)
                .where(totp_t.c.user_id == user_id, totp_t.c.enabled_at.is_(None))
                .values(
                    enabled_at=now,
                    last_used_step=step,
                    failed_attempts=0,
                    locked_until=None,
                    updated_at=now,
                )
            )
            if result.rowcount != 1:
                return False
            await self._replace_recovery_codes(conn, user_id, recovery_code_hashes, now)
        return True

    async def accept_totp_step(self, user_id: str, step: int) -> bool:
        """Record an accepted code; False when the period was already used."""
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(totp_t)
                .where(
                    totp_t.c.user_id == user_id,
                    totp_t.c.enabled_at.is_not(None),
                    or_(totp_t.c.last_used_step.is_(None), totp_t.c.last_used_step < step),
                )
                .values(
                    last_used_step=step,
                    failed_attempts=0,
                    locked_until=None,
                    updated_at=utc_now(),
                )
            )
        return result.rowcount == 1

    async def record_totp_failure(
        self, user_id: str, *, now: int, max_attempts: int, lock_seconds: int
    ) -> int | None:
        """Count a wrong code; return the lock expiry once the limit is reached."""
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    update(totp_t)
                    .where(totp_t.c.user_id == user_id)
                    .values(
                        failed_attempts=totp_t.c.failed_attempts + 1,
                        updated_at=utc_now(),
                    )
                    .returning(totp_t.c.failed_attempts)
                )
            ).first()
            if row is None or row.failed_attempts < max_attempts:
                return None
            locked_until = now + lock_seconds
            await conn.execute(
                update(totp_t)
                .where(totp_t.c.user_id == user_id)
                .values(failed_attempts=0, locked_until=locked_until)
            )
        return locked_until

    async def consume_totp_recovery_code(self, user_id: str, code_hash: str) -> bool:
        now = utc_now()
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(recovery_t)
                .where(
                    recovery_t.c.user_id == user_id,
                    recovery_t.c.code_hash == code_hash,
                    recovery_t.c.used_at.is_(None),
                )
                .values(used_at=now)
            )
            if result.rowcount != 1:
                return False
            await conn.execute(
                update(totp_t)
                .where(totp_t.c.user_id == user_id)
                .values(failed_attempts=0, locked_until=None, updated_at=now)
            )
        return True

    async def replace_totp_recovery_codes(self, user_id: str, code_hashes: list[str]) -> None:
        async with self._engine.begin() as conn:
            await self._replace_recovery_codes(conn, user_id, code_hashes, utc_now())

    async def totp_recovery_codes_remaining(self, user_id: str) -> int:
        async with read_connection(self._engine) as conn:
            value = (
                await conn.execute(
                    select(func.count())
                    .select_from(recovery_t)
                    .where(recovery_t.c.user_id == user_id, recovery_t.c.used_at.is_(None))
                )
            ).scalar_one()
        return int(value or 0)

    async def delete_totp(self, user_id: str) -> bool:
        async with self._engine.begin() as conn:
            await conn.execute(delete(recovery_t).where(recovery_t.c.user_id == user_id))
            result = await conn.execute(delete(totp_t).where(totp_t.c.user_id == user_id))
        return result.rowcount == 1

    async def _replace_recovery_codes(
        self, conn, user_id: str, code_hashes: list[str], now: str
    ) -> None:
        await conn.execute(delete(recovery_t).where(recovery_t.c.user_id == user_id))
        if code_hashes:
            await conn.execute(
                insert(recovery_t),
                [
                    {"user_id": user_id, "code_hash": code_hash, "used_at": None, "created_at": now}
                    for code_hash in code_hashes
                ],
            )
