"""Persistence for the E2EE ``required`` mode.

* Command registrations (``e2ee_command_registrations``). A registration is the plaintext side channel of a command that travels inside a secure channel: ids, a keyed
input digest and, once the device reports it through its outbox, the outcome. Never content.
* The off -> required switch: the last mode this database ran under, and the purge of plaintext display fields.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from agent_server.infra.db.engine import read_connection
from agent_server.infra.db.schema import e2ee_command_registrations, sessions

_t = e2ee_command_registrations


def _view(row: Any) -> dict[str, Any]:
    return {
        "commandId": row["command_id"],
        "userId": row["user_id"],
        "deviceId": row["device_id"],
        "inputDigest": row["input_digest"],
        "registeredAt": row["created_at"],
        "outcome": row["outcome"],
        "errorCode": row["error_code"],
        "finishedAt": row["finished_at"],
    }


class E2eeRepositoryMixin:
    async def register_e2ee_command(
        self,
        *,
        command_id: str,
        user_id: str,
        device_id: str,
        input_digest: str,
        now: str,
    ) -> tuple[dict[str, Any], bool]:
        """Insert the registration unless ``command_id`` exists. Returns ``(row, created)``; on a repeat the
        stored row is returned unchanged so the caller can compare it."""

        async with self._engine.begin() as conn:  # type: ignore[attr-defined]
            inserted = await conn.execute(
                pg_insert(_t)
                .values(
                    command_id=command_id,
                    user_id=user_id,
                    device_id=device_id,
                    input_digest=input_digest,
                    created_at=now,
                )
                .on_conflict_do_nothing(index_elements=[_t.c.command_id])
                .returning(_t.c.command_id)
            )
            created = inserted.first() is not None
            row = (
                await conn.execute(select(_t).where(_t.c.command_id == command_id))
            ).mappings().one()
        return _view(row), created

    async def get_e2ee_command(self, command_id: str) -> dict[str, Any] | None:
        async with read_connection(self._engine) as conn:  # type: ignore[attr-defined]
            row = (
                await conn.execute(select(_t).where(_t.c.command_id == command_id))
            ).mappings().first()
        return _view(row) if row is not None else None

    async def finish_e2ee_command(
        self,
        *,
        command_id: str,
        device_id: str,
        outcome: str,
        error_code: str | None,
        now: str,
    ) -> dict[str, Any] | None:
        """Record the first outcome the device reports; later reports change nothing. Returns the row, or
        ``None`` when no registration for this device has that id."""

        async with self._engine.begin() as conn:  # type: ignore[attr-defined]
            await conn.execute(
                update(_t)
                .where(
                    _t.c.command_id == command_id,
                    _t.c.device_id == device_id,
                    _t.c.outcome.is_(None),
                )
                .values(outcome=outcome, error_code=error_code, finished_at=now)
            )
            row = (
                await conn.execute(
                    select(_t).where(_t.c.command_id == command_id, _t.c.device_id == device_id)
                )
            ).mappings().first()
        return _view(row) if row is not None else None

    async def prune_e2ee_commands(self, *, device_id: str, before: str) -> int:
        """Drop one device's registrations older than ``before`` (uses the device/created index)."""

        async with self._engine.begin() as conn:  # type: ignore[attr-defined]
            result = await conn.execute(
                delete(_t).where(_t.c.device_id == device_id, _t.c.created_at < before)
            )
        return int(result.rowcount or 0)

    async def purge_plaintext_session_display(self) -> int:
        """Clear the plaintext display fields of every session (title, its source, working directory): what
        docs/v3/05-server.md §3.2 moves into the display envelope. Devices write sealed envelopes again once
        they are online. Returns the number of sessions changed."""

        async with self._engine.begin() as conn:  # type: ignore[attr-defined]
            result = await conn.execute(
                update(sessions)
                .where(
                    (sessions.c.title.is_not(None))
                    | (sessions.c.title_source.is_not(None))
                    | (sessions.c.cwd.is_not(None))
                )
                .values(title=None, title_source=None, cwd=None)
            )
        return int(result.rowcount or 0)
