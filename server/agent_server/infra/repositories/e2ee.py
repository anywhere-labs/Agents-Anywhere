"""Persistence for the E2EE ``required`` mode: the off -> required switch (the last mode this database ran
under, and the purge of plaintext display fields).

Command registrations live in ``device_commands`` with ``origin = 'sealed'`` (``repositories.device_link``).
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select, update

from agent_server.infra.db.schema import sessions


def _is_sealed(raw: str) -> bool:
    """Whether a stored display envelope is sealed; anything else (plain, unreadable) is plaintext."""

    try:
        envelope = json.loads(raw)
    except ValueError:
        return False
    return isinstance(envelope, dict) and envelope.get("mode") == "sealed"


class E2eeRepositoryMixin:
    async def purge_plaintext_session_display(self) -> int:
        """Clear the plaintext display fields of every session: title (and its source), working directory, and
        display envelopes that are not sealed (a plain ``displayDevice`` the device reported, a plain
        ``displayUser`` a rename wrote in normal mode). docs/v3/05-server.md §3.2 moves all of these into sealed
        display envelopes; sealed ones are kept. Devices write sealed envelopes again once they are online.
        Returns the number of sessions changed."""

        envelopes = (sessions.c.display_device, sessions.c.display_user)
        async with self._engine.begin() as conn:  # type: ignore[attr-defined]
            rows = (
                await conn.execute(
                    select(sessions.c.id, sessions.c.title, sessions.c.title_source, sessions.c.cwd, *envelopes).where(
                        (sessions.c.title.is_not(None))
                        | (sessions.c.title_source.is_not(None))
                        | (sessions.c.cwd.is_not(None))
                        | (sessions.c.display_device.is_not(None))
                        | (sessions.c.display_user.is_not(None))
                    )
                )
            ).all()
            changed = 0
            for row in rows:
                current = row._mapping
                values: dict[str, Any] = {
                    name: None for name in ("title", "title_source", "cwd") if current[name] is not None
                }
                for column in envelopes:
                    raw = current[column.name]
                    if raw is not None and not _is_sealed(raw):
                        values[column.name] = None
                if values:
                    await conn.execute(update(sessions).where(sessions.c.id == row.id).values(**values))
                    changed += 1
        return changed
