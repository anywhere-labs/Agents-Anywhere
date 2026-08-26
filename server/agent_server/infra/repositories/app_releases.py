from __future__ import annotations

from typing import Any

from sqlalchemy import insert, select
from sqlalchemy.exc import IntegrityError

from agent_server.core.utc import utc_now
from agent_server.infra.db import app_releases as app_releases_t


class AppReleaseRepositoryMixin:
    async def latest_app_release(self, platform: str) -> dict[str, Any] | None:
        query = (
            select(app_releases_t)
            .where(
                app_releases_t.c.platform == platform,
                app_releases_t.c.published == 1,
            )
            .order_by(app_releases_t.c.version_code.desc())
            .limit(1)
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(query)).mappings().first()
        return dict(row) if row is not None else None

    async def list_app_releases(self) -> list[dict[str, Any]]:
        query = select(app_releases_t).order_by(
            app_releases_t.c.created_at.desc(),
            app_releases_t.c.platform.asc(),
            app_releases_t.c.version_code.desc(),
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        return [dict(row) for row in rows]

    async def create_app_release(
        self,
        *,
        platform: str,
        version_code: int,
        version_name: str,
        download_url: str,
        sha256: str | None,
        published: bool,
    ) -> dict[str, Any]:
        now = utc_now()
        values = {
            "platform": platform,
            "version_code": version_code,
            "version_name": version_name,
            "download_url": download_url,
            "sha256": sha256,
            "published": int(published),
            "created_at": now,
            "updated_at": now,
        }
        try:
            async with self._engine.begin() as conn:
                await conn.execute(insert(app_releases_t).values(**values))
        except IntegrityError as exc:
            raise ValueError("release already exists") from exc
        return values
