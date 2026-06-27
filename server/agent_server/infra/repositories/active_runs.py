from __future__ import annotations

from typing import Any

from sqlalchemy import delete, insert, select, update
from sqlalchemy.ext.asyncio import AsyncEngine

from agent_server.infra.db import session_active_runs as active_runs_t


class ActiveRunRepository:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def upsert(
        self,
        *,
        session_id: str,
        runtime: str,
        status: str,
        started_at: str,
        updated_at: str,
        external_session_id: str | None = None,
        turn_id: str | None = None,
        params_json: str | None = None,
    ) -> None:
        async with self._engine.begin() as conn:
            existing = (
                await conn.execute(
                    select(active_runs_t.c.session_id).where(active_runs_t.c.session_id == session_id)
                )
            ).first()
            values = {
                "runtime": runtime,
                "external_session_id": external_session_id,
                "turn_id": turn_id,
                "status": status,
                "params_json": params_json,
                "updated_at": updated_at,
            }
            if existing is None:
                await conn.execute(
                    insert(active_runs_t).values(
                        session_id=session_id,
                        started_at=started_at,
                        **values,
                    )
                )
                return
            await conn.execute(
                update(active_runs_t)
                .where(active_runs_t.c.session_id == session_id)
                .values(**values)
            )

    async def update_turn_id(
        self,
        session_id: str,
        *,
        turn_id: str,
        updated_at: str,
    ) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(active_runs_t)
                .where(active_runs_t.c.session_id == session_id)
                .values(turn_id=turn_id, updated_at=updated_at)
            )

    async def get(self, session_id: str) -> Any | None:
        async with self._engine.connect() as conn:
            return (
                await conn.execute(
                    select(active_runs_t).where(active_runs_t.c.session_id == session_id)
                )
            ).mappings().first()

    async def delete(self, session_id: str) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(delete(active_runs_t).where(active_runs_t.c.session_id == session_id))

