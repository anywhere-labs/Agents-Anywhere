from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine


def normalize_async_database_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+asyncpg://", 1)
    return url


def create_engine(database_url: str) -> AsyncEngine:
    normalized = normalize_async_database_url(database_url)
    kwargs: dict = {"pool_pre_ping": True}
    if normalized.startswith("sqlite+"):
        kwargs.pop("pool_pre_ping", None)
    return create_async_engine(normalized, **kwargs)


async def check_database_health(engine: AsyncEngine) -> bool:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:  # noqa: BLE001
        return False
