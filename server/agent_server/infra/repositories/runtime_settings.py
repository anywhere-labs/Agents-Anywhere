from __future__ import annotations

from typing import Any

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncEngine

from agent_server.infra.db import (
    connectors as connectors_t,
    device_agent_settings as device_agent_settings_t,
    sessions as sessions_t,
)


class RuntimeSettingsRepository:
    def __init__(self, engine: AsyncEngine) -> None:
        self._engine = engine

    async def require_connector(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> str:
        query = select(connectors_t.c.id, connectors_t.c.user_id).where(
            connectors_t.c.id == connector_id,
            connectors_t.c.revoked == 0,
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(query)).first()
        if row is None:
            raise KeyError(connector_id)
        return str(row.user_id)

    async def get_device_settings_json(
        self,
        connector_id: str,
        runtime: str,
    ) -> str | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(device_agent_settings_t.c.settings_json).where(
                        device_agent_settings_t.c.connector_id == connector_id,
                        device_agent_settings_t.c.runtime == runtime,
                    )
                )
            ).first()
        return row.settings_json if row is not None else None

    async def upsert_device_settings_json(
        self,
        connector_id: str,
        runtime: str,
        *,
        settings_json: str,
        schema_version: int,
        updated_at: str,
    ) -> None:
        async with self._engine.begin() as conn:
            existing = (
                await conn.execute(
                    select(device_agent_settings_t.c.connector_id).where(
                        device_agent_settings_t.c.connector_id == connector_id,
                        device_agent_settings_t.c.runtime == runtime,
                    )
                )
            ).first()
            values = {
                "settings_json": settings_json,
                "schema_version": schema_version,
                "updated_at": updated_at,
            }
            if existing is None:
                await conn.execute(
                    insert(device_agent_settings_t).values(
                        connector_id=connector_id,
                        runtime=runtime,
                        **values,
                    )
                )
                return
            await conn.execute(
                update(device_agent_settings_t)
                .where(
                    device_agent_settings_t.c.connector_id == connector_id,
                    device_agent_settings_t.c.runtime == runtime,
                )
                .values(**values)
            )

    async def get_session_runtime_row(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> Any:
        query = (
            select(
                sessions_t.c.id,
                sessions_t.c.connector_id,
                sessions_t.c.runtime,
                sessions_t.c.runtime_settings_override,
                connectors_t.c.user_id.label("connector_user_id"),
            )
            .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
            .where(sessions_t.c.id == session_id, connectors_t.c.revoked == 0)
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(query)).mappings().first()
        if row is None:
            raise KeyError(session_id)
        return row

    async def set_session_runtime_override_json(
        self,
        session_id: str,
        *,
        override_json: str | None,
        updated_at: str,
    ) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(sessions_t)
                .where(sessions_t.c.id == session_id)
                .values(
                    runtime_settings_override=override_json,
                    updated_at=updated_at,
                )
            )
