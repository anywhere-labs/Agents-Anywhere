from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from agent_server.infra.db.schema import metadata

SQLITE_BACKEND = "sqlite"
POSTGRES_BACKEND = "postgres"


def resolve_db_url(*, backend: str | None = None, url: str | None = None, sqlite_path: str | Path | None = None) -> tuple[str, str]:
    """Return (backend, async_url) from explicit args or env vars.

    Precedence:
      1. AGENT_SERVER_DB_URL — explicit SQLAlchemy URL wins.
      2. AGENT_SERVER_DB_BACKEND + (AGENT_SERVER_DB for sqlite).
      3. Legacy AGENT_SERVER_DB — defaults to sqlite at that path.
    """
    url = url if url is not None else os.environ.get("AGENT_SERVER_DB_URL")
    backend = backend if backend is not None else os.environ.get("AGENT_SERVER_DB_BACKEND")
    legacy = sqlite_path if sqlite_path is not None else os.environ.get("AGENT_SERVER_DB")

    if url:
        resolved_backend = backend or _infer_backend_from_url(url)
        return resolved_backend, url

    if backend == POSTGRES_BACKEND:
        raise ValueError(
            "AGENT_SERVER_DB_BACKEND=postgres requires AGENT_SERVER_DB_URL "
            "(e.g. postgresql+asyncpg://user:pass@host:5432/dbname)"
        )

    path = str(legacy or "agent-server.sqlite3")
    return SQLITE_BACKEND, f"sqlite+aiosqlite:///{path}"


def _infer_backend_from_url(url: str) -> str:
    if url.startswith("postgresql"):
        return POSTGRES_BACKEND
    if url.startswith("sqlite"):
        return SQLITE_BACKEND
    raise ValueError(f"unsupported AGENT_SERVER_DB_URL scheme: {url}")


def build_engine(*, backend: str | None = None, url: str | None = None, sqlite_path: str | Path | None = None) -> tuple[str, AsyncEngine]:
    resolved_backend, async_url = resolve_db_url(backend=backend, url=url, sqlite_path=sqlite_path)
    # Async DB-API connections (aiosqlite, asyncpg) are bound to the event
    # loop that opened them. FastAPI/Starlette's TestClient uses anyio to run
    # each request in a fresh task/loop scope, so a pooled connection from a
    # prior request will trigger "different loop" or "no active connection"
    # errors when reused. NullPool opens a fresh connection per checkout,
    # sidestepping the issue. Cost at our scale is negligible.
    engine = create_async_engine(async_url, future=True, poolclass=NullPool)
    if resolved_backend == SQLITE_BACKEND:
        _enable_sqlite_fk(engine)
    return resolved_backend, engine


def _enable_sqlite_fk(engine: AsyncEngine) -> None:
    @event.listens_for(engine.sync_engine, "connect")
    def _on_connect(dbapi_conn, _record):  # noqa: ANN001 — SQLAlchemy event signature
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys = ON")
        cursor.close()


async def init_db(engine: AsyncEngine) -> None:
    async with engine.begin() as conn:
        await conn.run_sync(metadata.create_all)


def init_db_sync(async_url: str) -> None:
    """Run metadata.create_all from a sync context.

    Useful at startup when there is no event loop yet (e.g. during app
    construction). Idempotent — uses CREATE TABLE IF NOT EXISTS semantics.

    For sqlite we use a transient sync engine (no extra driver required).
    For other backends we spin up a transient async engine on a fresh event
    loop so users don't need to install a separate sync driver (e.g. psycopg2)
    just for schema setup.
    """
    if async_url.startswith("sqlite+aiosqlite:") or async_url.startswith("sqlite:"):
        sync_url = (
            "sqlite:" + async_url[len("sqlite+aiosqlite:"):]
            if async_url.startswith("sqlite+aiosqlite:")
            else async_url
        )
        sync_engine = create_engine(sync_url, future=True)

        @event.listens_for(sync_engine, "connect")
        def _on_connect(dbapi_conn, _record):  # noqa: ANN001
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA foreign_keys = ON")
            cursor.close()

        try:
            metadata.create_all(sync_engine)
        finally:
            sync_engine.dispose()
        return

    import asyncio
    import threading

    async def _run() -> None:
        engine = create_async_engine(async_url, future=True)
        try:
            await init_db(engine)
        finally:
            await engine.dispose()

    # Run on a worker thread so this works whether the caller is in a running
    # event loop (e.g. inside an async test) or not. asyncio.run() refuses to
    # nest into an existing loop, so we spin up a private one in a thread.
    captured: list[BaseException] = []

    def _runner() -> None:
        try:
            asyncio.run(_run())
        except BaseException as exc:  # noqa: BLE001 — propagate any failure
            captured.append(exc)

    thread = threading.Thread(target=_runner, name="init-db-sync")
    thread.start()
    thread.join()
    if captured:
        raise captured[0]

