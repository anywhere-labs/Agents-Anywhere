from __future__ import annotations

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from agent_server.infra.db import instance_settings as instance_settings_t
from agent_server.core.utc import utc_now


class InstanceSettingsRepository:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def get(self, key: str, default: str | None = None) -> str | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(instance_settings_t.c.value).where(instance_settings_t.c.key == key)
                )
            ).first()
        return row.value if row is not None else default

    async def set(self, key: str, value: str) -> None:
        now = utc_now()
        async with self._engine.begin() as conn:
            await self.upsert_on_connection(conn, key, value, now)

    async def upsert_on_connection(
        self,
        conn: AsyncConnection,
        key: str,
        value: str,
        now: str,
    ) -> None:
        existing = (
            await conn.execute(
                select(instance_settings_t.c.key).where(instance_settings_t.c.key == key)
            )
        ).first()
        if existing is None:
            await conn.execute(
                insert(instance_settings_t).values(key=key, value=value, updated_at=now)
            )
            return
        await conn.execute(
            update(instance_settings_t)
            .where(instance_settings_t.c.key == key)
            .values(value=value, updated_at=now)
        )
