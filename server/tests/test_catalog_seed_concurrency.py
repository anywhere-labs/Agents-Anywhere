"""Exercise the actual startup seed path under competing processes/threads."""

from __future__ import annotations

import asyncio
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from sqlalchemy import delete, select

from agent_server.infra.db import (
    agent_efforts as agent_efforts_t,
    agent_models as agent_models_t,
    instance_settings as instance_settings_t,
)
from agent_server.infra.repositories.facade import Store


def _concurrent_seed_stores(db_url: str) -> list[Store]:
    """Start two catalog seeds at the same instant against an initialized DB.

    Store construction invokes the synchronous catalog seed path, which is the
    path that historically used a check-then-insert race.
    """
    # Table creation is a separate startup concern. Initialize it once, then
    # race the actual catalog seed operation against stable schema metadata.
    bootstrap = Store(db_url=db_url)

    async def clear_seed_rows() -> None:
        async with bootstrap.engine.begin() as conn:
            await conn.execute(delete(agent_models_t).where(agent_models_t.c.runtime == "codex"))
            await conn.execute(delete(agent_efforts_t).where(agent_efforts_t.c.runtime == "codex"))
            await conn.execute(delete(instance_settings_t))

    asyncio.run(clear_seed_rows())
    asyncio.run(bootstrap.close())
    barrier = threading.Barrier(2)

    def construct() -> Store:
        barrier.wait(timeout=10)
        return Store(db_url=db_url)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(construct) for _ in range(2)]
        return [future.result(timeout=30) for future in futures]


async def _catalog_keys(store: Store) -> tuple[list[str], list[str]]:
    async with store.engine.connect() as conn:
        model_keys = list(
            (
                await conn.execute(
                    select(agent_models_t.c.key)
                    .where(agent_models_t.c.runtime == "codex")
                    .order_by(agent_models_t.c.sort_order)
                )
            ).scalars()
        )
        effort_keys = list(
            (
                await conn.execute(
                    select(agent_efforts_t.c.key)
                    .where(agent_efforts_t.c.runtime == "codex")
                    .order_by(agent_efforts_t.c.sort_order)
                )
            ).scalars()
        )
    return model_keys, effort_keys


def _assert_seeded_once(stores: list[Store]) -> None:
    try:
        model_keys, effort_keys = asyncio.run(_catalog_keys(stores[0]))
        assert model_keys == [
            "gpt-5.5",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.3-codex",
            "gpt-5.2",
        ]
        assert effort_keys == ["low", "medium", "high", "xhigh"]
    finally:
        for store in stores:
            asyncio.run(store.close())


def test_catalog_seed_is_atomic_under_concurrent_sqlite_startup(tmp_path: Path) -> None:
    db_url = f"sqlite+aiosqlite:///{tmp_path / 'catalog-race.sqlite3'}"
    _assert_seeded_once(_concurrent_seed_stores(db_url))


def test_catalog_seed_is_atomic_under_concurrent_postgres_startup() -> None:
    db_url = os.environ.get("AGENT_SERVER_DB_URL")
    if not db_url or not db_url.startswith("postgresql"):
        pytest.skip("AGENT_SERVER_DB_URL is not a live PostgreSQL database")
    _assert_seeded_once(_concurrent_seed_stores(db_url))
