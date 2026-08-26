from __future__ import annotations

from typing import Any

from sqlalchemy import select

from agent_server.infra.db import android_app_releases as android_app_releases_t


class AppReleaseRepositoryMixin:
    async def latest_android_app_release(self) -> dict[str, Any] | None:
        query = (
            select(android_app_releases_t)
            .where(android_app_releases_t.c.published == 1)
            .order_by(android_app_releases_t.c.version_code.desc())
            .limit(1)
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(query)).mappings().first()
        return dict(row) if row is not None else None
