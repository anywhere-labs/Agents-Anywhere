"""PostgreSQL engine factory."""

from __future__ import annotations

import os

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

DEFAULT_POSTGRES_POOL_SIZE = 10
DEFAULT_POSTGRES_MAX_OVERFLOW = 20
DEFAULT_POSTGRES_POOL_TIMEOUT_SECONDS = 30.0
DEFAULT_POSTGRES_POOL_RECYCLE_SECONDS = 1800


def resolve_db_url(url: str | None = None) -> str:
    """Resolve the PostgreSQL URL from the argument or ``AGENT_SERVER_DB_URL``."""

    url = url if url is not None else os.environ.get("AGENT_SERVER_DB_URL")
    if not url:
        raise ValueError(
            "AGENT_SERVER_DB_URL is required "
            "(e.g. postgresql+asyncpg://user:pass@host:5432/dbname)"
        )
    if not url.startswith("postgresql"):
        raise ValueError(f"unsupported AGENT_SERVER_DB_URL scheme: {url}")
    return url


def build_engine(url: str | None = None) -> AsyncEngine:
    async_url = resolve_db_url(url)
    engine_kwargs: dict[str, object] = {"future": True}
    if _env_flag("AGENT_SERVER_DB_NULL_POOL"):
        # Test suites drive one app from many short-lived event loops
        # (asyncio.run per assertion, TestClient portals); pooled asyncpg
        # connections would be reused across loops and fail. NullPool opens a
        # connection per checkout, which is cheap against a local Postgres.
        engine_kwargs["poolclass"] = NullPool
    else:
        engine_kwargs.update(
            pool_size=_env_int(
                "AGENT_SERVER_DB_POOL_SIZE", DEFAULT_POSTGRES_POOL_SIZE, minimum=1
            ),
            max_overflow=_env_int(
                "AGENT_SERVER_DB_MAX_OVERFLOW",
                DEFAULT_POSTGRES_MAX_OVERFLOW,
                minimum=0,
            ),
            pool_timeout=_env_float(
                "AGENT_SERVER_DB_POOL_TIMEOUT",
                DEFAULT_POSTGRES_POOL_TIMEOUT_SECONDS,
                minimum=0.1,
            ),
            pool_recycle=_env_int(
                "AGENT_SERVER_DB_POOL_RECYCLE",
                DEFAULT_POSTGRES_POOL_RECYCLE_SECONDS,
                minimum=1,
            ),
            pool_pre_ping=True,
        )
    return create_async_engine(async_url, **engine_kwargs)


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int, *, minimum: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value


def _env_float(name: str, default: float, *, minimum: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc
    if value < minimum:
        raise ValueError(f"{name} must be at least {minimum}")
    return value
