"""A throwaway PostgreSQL database for the headless DSH probes.

The probes build the Server app in-process; the Server runs on PostgreSQL only,
so each probe creates its own database next to the one named by
``AGENT_SERVER_TEST_DB_URL`` (the same variable the Server test suite uses),
migrates it and drops it when done.
"""

from __future__ import annotations

import asyncio
import os
import secrets
from collections.abc import Iterator
from contextlib import contextmanager

TEST_DB_ENV = "AGENT_SERVER_TEST_DB_URL"


def _asyncpg_url(url: str) -> str:
    return "postgresql:" + url[len("postgresql+asyncpg:") :] if url.startswith("postgresql+asyncpg:") else url


async def _execute(url: str, sql: str) -> None:
    import asyncpg

    conn = await asyncpg.connect(_asyncpg_url(url))
    try:
        await conn.execute(sql)
    finally:
        await conn.close()


@contextmanager
def fresh_server_database() -> Iterator[str]:
    """Create a fresh database, point ``AGENT_SERVER_DB_URL`` at it, migrate, drop afterwards."""

    base_url = os.environ.get(TEST_DB_ENV, "").strip()
    if not base_url.startswith("postgresql"):
        raise SystemExit(
            f"{TEST_DB_ENV} must point at a throwaway PostgreSQL database "
            "(see server/tests/conftest.py); the DSH probes build the Server in-process"
        )
    database = base_url.rsplit("/", 1)[-1].split("?", 1)[0]
    if "test" not in database:
        raise SystemExit(f"{TEST_DB_ENV} must name a database containing 'test', got {database!r}")
    prefix, _, _ = base_url.rpartition("/")
    name = f"aa_probe_{secrets.token_hex(6)}"
    url = f"{prefix}/{name}"
    asyncio.run(_execute(base_url, f'CREATE DATABASE "{name}"'))
    previous = os.environ.get("AGENT_SERVER_DB_URL")
    os.environ["AGENT_SERVER_DB_URL"] = url
    # The probes drive the app from several event loops; see engine.build_engine.
    os.environ.setdefault("AGENT_SERVER_DB_NULL_POOL", "1")
    try:
        from agent_server.infra.db.migrations import upgrade_database

        upgrade_database(db_url=url)
        yield url
    finally:
        if previous is None:
            os.environ.pop("AGENT_SERVER_DB_URL", None)
        else:
            os.environ["AGENT_SERVER_DB_URL"] = previous
        asyncio.run(_execute(base_url, f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
