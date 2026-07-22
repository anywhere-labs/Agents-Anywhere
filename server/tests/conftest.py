"""Pytest fixtures shared across tests.

When AGENT_SERVER_DB_URL points at a real database (e.g. Postgres) the tests
share state across runs, unlike the per-tmp_path sqlite default. Truncate
known tables before each test so tests stay isolated.
"""

from __future__ import annotations

import asyncio
import os

import pytest
from fastapi.testclient import TestClient


_PG_PREFIX = "postgresql"
_API_PREFIX = "/api/v2"
_API_ROOTS = (
    "/.well-known",
    "/admin",
    "/agents",
    "/auth",
    "/connector",
    "/connectors",
    "/health",
    "/oauth",
    "/pairing",
    "/sessions",
    "/ws-ticket",
)
_TRUNCATE_SQL = (
    "TRUNCATE TABLE dashboard_daily_metrics, dashboard_user_daily_facts, dashboard_settings, "
    "timeline_items, approvals, notices, session_active_runs, "
    "sessions, "
    "connector_runtime_catalogs, device_agent_settings, pairing_codes, connectors, users, instance_settings "
    "RESTART IDENTITY CASCADE"
)


def _asyncpg_url(url: str) -> str:
    if url.startswith("postgresql+asyncpg:"):
        return "postgresql:" + url[len("postgresql+asyncpg:"):]
    return url


def _api_v2_test_path(url: str) -> str:
    if not url.startswith("/"):
        return url
    if url == _API_PREFIX or url.startswith(f"{_API_PREFIX}/"):
        return url
    if any(url == root or url.startswith(f"{root}/") or url.startswith(f"{root}?") for root in _API_ROOTS):
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
