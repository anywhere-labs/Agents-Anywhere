"""Pytest fixtures shared across tests.

When AGENT_SERVER_DB_URL points at a real database (e.g. Postgres) the tests
share state across runs, unlike the per-tmp_path sqlite default. Truncate
known tables before each test so tests stay isolated.
"""

from __future__ import annotations

import asyncio
import os

import pytest


_PG_PREFIX = "postgresql"
_TRUNCATE_SQL = (
    "TRUNCATE TABLE timeline_items, approvals, session_active_runs, "
    "sessions, "
    "device_agent_settings, pairing_codes, connectors, users, instance_settings, "
    "agent_modes, agent_models, agent_efforts RESTART IDENTITY CASCADE"
)


def _asyncpg_url(url: str) -> str:
    if url.startswith("postgresql+asyncpg:"):
        return "postgresql:" + url[len("postgresql+asyncpg:"):]
    return url


async def _truncate(url: str) -> None:
    import asyncpg

    conn = await asyncpg.connect(url)
    try:
        try:
            await conn.execute(_TRUNCATE_SQL)
        except asyncpg.UndefinedTableError:
            # Tables may not exist yet on the very first run; create_app()
            # will create them and subsequent invocations will succeed.
            pass
    finally:
        await conn.close()


@pytest.fixture(autouse=True)
def _isolate_external_database() -> None:
    url = os.environ.get("AGENT_SERVER_DB_URL")
    if not url or not url.startswith(_PG_PREFIX):
        return
    asyncio.run(_truncate(_asyncpg_url(url)))
