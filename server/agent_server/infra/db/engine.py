from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

SQLITE_BACKEND = "sqlite"
POSTGRES_BACKEND = "postgres"
DEFAULT_POSTGRES_POOL_SIZE = 10
DEFAULT_POSTGRES_MAX_OVERFLOW = 20
DEFAULT_POSTGRES_POOL_TIMEOUT_SECONDS = 30.0
DEFAULT_POSTGRES_POOL_RECYCLE_SECONDS = 1800


def resolve_db_url(
    *,
    backend: str | None = None,
    url: str | None = None,
    sqlite_path: str | Path | None = None,
) -> tuple[str, str]:
    """Resolve a PostgreSQL runtime URL or an explicitly requested SQLite URL.

    SQLite is retained only for tests and the legacy import pipeline. Normal
    runtime configuration must use AGENT_SERVER_DB_URL with PostgreSQL.
    """
    explicit_url = url is not None
    url = url if explicit_url else os.environ.get("AGENT_SERVER_DB_URL")
    backend = (
        backend if backend is not None else os.environ.get("AGENT_SERVER_DB_BACKEND")
    )

    if url:
        inferred_backend = _infer_backend_from_url(url)
        if backend is not None and backend != inferred_backend:
            raise ValueError(
                f"database backend {backend!r} does not match "
                f"URL backend {inferred_backend!r}"
            )
        if inferred_backend == SQLITE_BACKEND and not explicit_url:
            raise ValueError(
                "SQLite runtime configuration is no longer supported; "
                "set AGENT_SERVER_DB_URL to a postgresql+asyncpg URL"
            )
        resolved_backend = backend or inferred_backend
        return resolved_backend, url

    if sqlite_path is not None:
        if backend not in (None, SQLITE_BACKEND):
            raise ValueError("sqlite_path cannot be used with a non-SQLite backend")
        return SQLITE_BACKEND, f"sqlite+aiosqlite:///{sqlite_path}"

    if backend == SQLITE_BACKEND or os.environ.get("AGENT_SERVER_DB"):
        raise ValueError(
            "SQLite runtime configuration is no longer supported; "
            "set AGENT_SERVER_DB_URL to a postgresql+asyncpg URL"
        )

    raise ValueError(
        "AGENT_SERVER_DB_URL is required "
        "(e.g. postgresql+asyncpg://user:pass@host:5432/dbname)"
    )


def _infer_backend_from_url(url: str) -> str:
    if url.startswith("postgresql"):
        return POSTGRES_BACKEND
    if url.startswith("sqlite"):
        return SQLITE_BACKEND
    raise ValueError(f"unsupported AGENT_SERVER_DB_URL scheme: {url}")


def build_engine(
    *,
    backend: str | None = None,
    url: str | None = None,
    sqlite_path: str | Path | None = None,
) -> tuple[str, AsyncEngine]:
    resolved_backend, async_url = resolve_db_url(
        backend=backend, url=url, sqlite_path=sqlite_path
    )
    engine_kwargs: dict[str, object] = {"future": True}
    if resolved_backend == SQLITE_BACKEND:
        # Async DB-API connections are bound to the event loop that opened
        # them. FastAPI/Starlette's TestClient uses anyio to run requests in
        # fresh loop scopes, so SQLite keeps NullPool to avoid reusing
        # connections across loops. Postgres should use SQLAlchemy's default
        # async pool; opening a new TCP connection per checkout is too costly
        # for production request latency.
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
    engine = create_async_engine(async_url, **engine_kwargs)
    if resolved_backend == SQLITE_BACKEND:
        _enable_sqlite_fk(engine)
    return resolved_backend, engine


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


def _enable_sqlite_fk(engine: AsyncEngine) -> None:
    @event.listens_for(engine.sync_engine, "connect")
    def _on_connect(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys = ON")
        cursor.close()
