"""Pytest fixtures shared across tests.

When AGENT_SERVER_DB_URL points at a real database (e.g. Postgres) the tests
share state across runs, unlike the per-tmp_path sqlite default. Truncate
known tables before each test so tests stay isolated.
"""

from __future__ import annotations

import asyncio
import os
import pathlib
import shutil
import tempfile

import pytest
from fastapi.testclient import TestClient

# Tests that open a connector socket without a responder must not wait the full
# production timeout for every runtime RPC.
os.environ.setdefault("AGENT_SERVER_RUNTIME_RPC_TIMEOUT_SECONDS", "0.2")
os.environ.setdefault("AGENT_SERVER_SESSION_RPC_TIMEOUT_SECONDS", "0.2")
# Every test signs in at least once; the production PBKDF2 cost dominates otherwise.
os.environ.setdefault("AGENT_SERVER_PASSWORD_ITERATIONS", "1000")

_TEMPLATE_DB: pathlib.Path | None = None


def migrated_template_db() -> pathlib.Path:
    """One migrated database per session.

    Building the schema costs ~0.15s per test and the suite creates one database
    per test, so the schema is migrated once and copied afterwards (~0.01s).
    """
    global _TEMPLATE_DB
    if _TEMPLATE_DB is None:
        from agent_server.app import create_app

        directory = pathlib.Path(tempfile.mkdtemp(prefix="agent-server-template-"))
        path = directory / "template.sqlite3"
        create_app(path)
        _TEMPLATE_DB = path
    return _TEMPLATE_DB


def make_test_client(destination: pathlib.Path) -> TestClient:
    """Return a client backed by a private copy of the migrated template."""
    from agent_server.app import create_app

    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(migrated_template_db(), destination)
    return ApiV2TestClient(create_app(destination))

_PG_PREFIX = "postgresql"
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
_TRUNCATE_SQL = (
    "TRUNCATE TABLE email_verification_codes, email_verification_limits, dashboard_daily_metrics, dashboard_user_daily_facts, dashboard_settings, "
    "session_shares, timeline_items, session_active_runs, "
    "sessions, projects, "
    "connector_runtime_catalogs, connector_protocol_capabilities, device_runtimes, "
    "connector_runtime_types, "
    "pairing_codes, connectors, users, instance_settings "
    "RESTART IDENTITY CASCADE"
)


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
