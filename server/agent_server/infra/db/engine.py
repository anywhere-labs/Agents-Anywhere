"""PostgreSQL engine factory."""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from anyio import CancelScope
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool
from sqlalchemy.util import await_

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
    engine = create_async_engine(async_url, **engine_kwargs)
    if engine.dialect.driver == "asyncpg":
        # The asyncpg dialect wraps its pre-ping in BEGIN/ROLLBACK so that it
        # works behind pgbouncer in transaction mode. The Server connects to
        # PostgreSQL directly, where that turns every pool checkout into three
        # round trips and one rollback; a plain simple-protocol query checks
        # the connection in one. The pool still skips fresh connections and
        # invalidates itself when the ping reports a disconnect.
        engine.sync_engine.dialect.do_ping = _ping_outside_transaction  # type: ignore[method-assign]
    return engine


@asynccontextmanager
async def read_connection(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    """Open a connection for read-only work.

    Statements run in autocommit, so a read is one round trip instead of
    BEGIN, the query and the ROLLBACK that ends an uncommitted
    ``engine.connect()``. Each statement still sees its own snapshot, the same
    as under READ COMMITTED. Writes that must be atomic belong in
    ``engine.begin()``; session-level advisory locks work here unchanged.
    """

    async with engine.connect() as conn:
        await conn.execution_options(isolation_level="AUTOCOMMIT")
        yield conn


def _ping_outside_transaction(dbapi_connection: Any) -> bool:
    # Simple-protocol "SELECT 1": one round trip, no prepared statement. An
    # empty query (";") would answer EmptyQueryResponse, which asyncpg's
    # simple-query path cannot parse.
    try:
        await_(dbapi_connection.driver_connection.execute("SELECT 1"))
    except Exception as error:  # noqa: BLE001 - re-raised as the DBAPI error
        # Translate to the DBAPI exception the dialect classifies as a
        # disconnect, as the stock asyncpg ping does.
        dbapi_connection._handle_exception(error)
    return True


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


@asynccontextmanager
async def closing_connection(
    engine: AsyncEngine, *, write: bool = False
) -> AsyncIterator[AsyncConnection]:
    """Finish transaction cleanup in the owning task before its ASGI scope exits.

    AsyncConnection.__aexit__ detaches close into another task. A short-lived
    ASGI portal can cancel that child before rollback completes. Close directly,
    shielding cleanup only; queries and caller work remain cancellable.
    """
    connection = await engine.connect()
    try:
        if write:
            await connection.begin()
        try:
            yield connection
        except BaseException:
            with CancelScope(shield=True):
                await connection.rollback()
            raise
        else:
            if write:
                with CancelScope(shield=True):
                    await connection.commit()
    finally:
        with CancelScope(shield=True):
            await connection.close()
