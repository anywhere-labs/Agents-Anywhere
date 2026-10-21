"""Pytest fixtures shared across tests.

The Server test suite runs against a real PostgreSQL database. Point
``AGENT_SERVER_TEST_DB_URL`` at a throwaway database (its name must contain
``test``); every table is truncated before each test so tests stay isolated.
Locally:

    docker compose -f docker/docker-compose.local.yml up -d postgres
    docker compose -f docker/docker-compose.local.yml exec postgres \
        psql -U agents_anywhere -c 'CREATE DATABASE agents_anywhere_test'
    export AGENT_SERVER_TEST_DB_URL=postgresql+asyncpg://agents_anywhere:agents_anywhere_dev_password@127.0.0.1:55432/agents_anywhere_test
"""

from __future__ import annotations

import asyncio
import os
import secrets
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

# Tests that open a connector socket without a responder must not wait the full
# production timeout for every runtime RPC.
os.environ.setdefault("AGENT_SERVER_RUNTIME_RPC_TIMEOUT_SECONDS", "0.2")
os.environ.setdefault("AGENT_SERVER_SESSION_RPC_TIMEOUT_SECONDS", "0.2")
# Every test signs in at least once; the production PBKDF2 cost dominates otherwise.
os.environ.setdefault("AGENT_SERVER_PASSWORD_ITERATIONS", "1000")
# Most tests exercise protocol behavior. The process pool has dedicated tests.
os.environ.setdefault("AGENT_SERVER_EVENT_WORKERS", "0")
# Tests run one app from many short-lived event loops; see engine.build_engine.
os.environ.setdefault("AGENT_SERVER_DB_NULL_POOL", "1")

_TEST_DB_ENV = "AGENT_SERVER_TEST_DB_URL"
_PG_PREFIX = "postgresql"


def _test_database_url() -> str:
    url = os.environ.get(_TEST_DB_ENV, "").strip()
    if not url:
        raise pytest.UsageError(
            f"{_TEST_DB_ENV} is not set. The Server tests need a throwaway "
            "PostgreSQL database; see tests/conftest.py for the local setup."
        )
    if not url.startswith(_PG_PREFIX):
        raise pytest.UsageError(f"{_TEST_DB_ENV} must be a postgresql+asyncpg URL")
    database = url.rsplit("/", 1)[-1].split("?", 1)[0]
    if "test" not in database:
        # The suite truncates every table; never let it near a real database.
        raise pytest.UsageError(
            f"{_TEST_DB_ENV} must name a database containing 'test', got {database!r}"
        )
    return url


TEST_DATABASE_URL = _test_database_url()
# Application code resolves the database through AGENT_SERVER_DB_URL.
os.environ["AGENT_SERVER_DB_URL"] = TEST_DATABASE_URL


def make_test_client() -> TestClient:
    """Return an API client on the shared test database.

    The autouse fixture migrates and truncates the database before every test;
    scripts that reuse this helper call ``reset_shared_database()`` themselves.
    """
    from agent_server.app import create_app

    return ApiV2TestClient(create_app())


_API_PREFIX = "/api/v2"
_API_ROOTS = (
    "/.well-known",
    "/admin",
    "/agents",
    "/auth",
    "/connector",
    "/connectors",
    "/dashboard",
    "/health",
    "/oauth",
    "/pairing",
    "/projects",
    "/sessions",
    "/ws-ticket",
)
def _truncate_sql() -> str:
    from agent_server.infra.db.schema import metadata

    tables = ", ".join(sorted(table.name for table in metadata.sorted_tables))
    return f"TRUNCATE TABLE {tables} RESTART IDENTITY CASCADE"


def _asyncpg_url(url: str) -> str:
    if url.startswith("postgresql+asyncpg:"):
        return "postgresql:" + url[len("postgresql+asyncpg:") :]
    return url


def _api_v2_test_path(url: str) -> str:
    if not url.startswith("/"):
        return url
    if url == _API_PREFIX or url.startswith(f"{_API_PREFIX}/"):
        return url
    if any(
        url == root or url.startswith((f"{root}/", f"{root}?")) for root in _API_ROOTS
    ):
        return f"{_API_PREFIX}{url}"
    return url


class ApiV2TestClient(TestClient):
    def request(self, method: str, url: str, *args, **kwargs):
        return super().request(method, _api_v2_test_path(str(url)), *args, **kwargs)

    def websocket_connect(self, url: str, *args, **kwargs):
        return super().websocket_connect(_api_v2_test_path(str(url)), *args, **kwargs)


async def _truncate(url: str) -> None:
    import asyncpg

    conn = await asyncpg.connect(url)
    try:
        try:
            await conn.execute(_truncate_sql())
        except asyncpg.UndefinedTableError:
            # Tables may not exist yet on the very first run; create_app()
            # migrates the database and subsequent invocations will succeed.
            pass
    finally:
        await conn.close()


_SCHEMA_READY = False


def _ensure_migrated() -> None:
    """Migrate the shared test database once per session."""
    global _SCHEMA_READY
    if _SCHEMA_READY:
        return
    from agent_server.infra.db.migrations import upgrade_database

    upgrade_database(db_url=TEST_DATABASE_URL)
    _SCHEMA_READY = True


def reset_shared_database() -> None:
    """Migrate the shared test database once, then empty every table."""
    _ensure_migrated()
    asyncio.run(_truncate(_asyncpg_url(TEST_DATABASE_URL)))


@pytest.fixture(autouse=True)
def _isolate_shared_database() -> None:
    reset_shared_database()


async def _run_maintenance(url: str, sql: str) -> None:
    import asyncpg

    conn = await asyncpg.connect(url)
    try:
        await conn.execute(sql)
    finally:
        await conn.close()


@pytest.fixture
def fresh_database_url() -> Iterator[str]:
    """A brand-new, empty PostgreSQL database for tests that drive migrations.

    The database is created next to the shared test database and dropped
    afterwards. The URL uses the same credentials and the asyncpg driver.
    """
    base, _, _ = TEST_DATABASE_URL.rpartition("/")
    name = f"aa_test_{secrets.token_hex(6)}"
    maintenance = _asyncpg_url(TEST_DATABASE_URL)
    asyncio.run(_run_maintenance(maintenance, f'CREATE DATABASE "{name}"'))
    try:
        yield f"{base}/{name}"
    finally:
        asyncio.run(
            _run_maintenance(maintenance, f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        )
