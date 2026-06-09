from __future__ import annotations

from typing import Any

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncEngine

from agent_server.infra.db import claude_transcript_cursors as cursors_t
from agent_server.infra.db import sessions as sessions_t


class ClaudeTranscriptCursorRepository:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def get(self, session_id: str) -> Any | None:
        async with self._engine.connect() as conn:
            return (
                await conn.execute(
                    select(cursors_t).where(cursors_t.c.session_id == session_id)
                )
            ).mappings().first()

    async def list_for_connector(self, connector_id: str) -> list[Any]:
        async with self._engine.connect() as conn:
            return list(
                (
                    await conn.execute(
                        select(cursors_t)
                        .join(sessions_t, sessions_t.c.id == cursors_t.c.session_id)
                        .where(
                            sessions_t.c.connector_id == connector_id,
                            sessions_t.c.runtime == "claude",
                        )
                    )
                )
                .mappings()
                .all()
            )

    async def upsert(
        self,
        *,
        session_id: str,
        transcript_path: str,
        last_offset: int,
        last_event_key: str | None,
        updated_at: str,
    ) -> None:
        async with self._engine.begin() as conn:
            existing = (
                await conn.execute(
                    select(cursors_t).where(cursors_t.c.session_id == session_id)
                )
            ).mappings().first()
            values = {
                "transcript_path": transcript_path,
                "last_offset": last_offset,
                "last_event_key": last_event_key,
                "updated_at": updated_at,
            }
            if existing is None:
                await conn.execute(insert(cursors_t).values(session_id=session_id, **values))
                return
            if (
                existing["transcript_path"] == transcript_path
                and last_offset < int(existing["last_offset"])
            ):
                return
            await conn.execute(
                update(cursors_t)
                .where(cursors_t.c.session_id == session_id)
                .values(**values)
            )
