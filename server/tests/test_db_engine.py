"""Round trips spent on pool checkout and read-only connections."""

from __future__ import annotations

import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from agent_server.infra.db.engine import build_engine, read_connection


async def _driver_queries(conn: AsyncConnection, body) -> list[str]:
    """Run ``body`` and return every statement asyncpg sent on this connection."""

    raw = await conn.get_raw_connection()
    driver = raw.dbapi_connection.driver_connection
    seen: list[str] = []

    def log(record) -> None:
        seen.append(record.query.strip())

    driver.add_query_logger(log)
    try:
        await body()
    finally:
        driver.remove_query_logger(log)
    return seen


def test_pool_checkout_pings_without_a_transaction(monkeypatch, fresh_database_url) -> None:
    monkeypatch.delenv("AGENT_SERVER_DB_NULL_POOL", raising=False)
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_SIZE", "1")
    monkeypatch.setenv("AGENT_SERVER_DB_MAX_OVERFLOW", "0")

    async def run() -> None:
        engine = build_engine(url=fresh_database_url)
        try:
            async with engine.connect() as conn:  # fresh: the pool skips the ping
                await conn.execute(text("SELECT 1"))
                raw = await conn.get_raw_connection()
                driver = raw.dbapi_connection.driver_connection
            seen: list[str] = []
            driver.add_query_logger(lambda record: seen.append(record.query.strip()))
            async with engine.connect():  # reused: pinged on checkout
                pass
            assert seen == ["SELECT 1"]
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_pool_replaces_a_connection_the_server_closed(monkeypatch, fresh_database_url) -> None:
    monkeypatch.delenv("AGENT_SERVER_DB_NULL_POOL", raising=False)
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_SIZE", "1")
    monkeypatch.setenv("AGENT_SERVER_DB_MAX_OVERFLOW", "0")

    async def run() -> None:
        engine = build_engine(url=fresh_database_url)
        admin = build_engine(url=fresh_database_url)
        try:
            async with engine.connect() as conn:
                old_pid = (await conn.execute(text("SELECT pg_backend_pid()"))).scalar_one()
            async with read_connection(admin) as conn:
                await conn.execute(text("SELECT pg_terminate_backend(:pid)"), {"pid": old_pid})
            async with read_connection(engine) as conn:
                new_pid = (await conn.execute(text("SELECT pg_backend_pid()"))).scalar_one()
            assert new_pid != old_pid
        finally:
            await engine.dispose()
            await admin.dispose()

    asyncio.run(run())


def test_read_connection_runs_each_statement_in_its_own_transaction(fresh_database_url) -> None:
    async def run() -> None:
        engine = build_engine(url=fresh_database_url)
        try:
            async with read_connection(engine) as conn:

                async def two_reads() -> None:
                    first = (await conn.execute(text("SELECT txid_current()"))).scalar_one()
                    second = (await conn.execute(text("SELECT txid_current()"))).scalar_one()
                    assert first != second

                seen = await _driver_queries(conn, two_reads)
            assert not any(q.upper().startswith(("BEGIN", "ROLLBACK", "COMMIT")) for q in seen)

            async with engine.begin() as conn:
                first = (await conn.execute(text("SELECT txid_current()"))).scalar_one()
                second = (await conn.execute(text("SELECT txid_current()"))).scalar_one()
                assert first == second
        finally:
            await engine.dispose()

    asyncio.run(run())


def test_writes_after_a_read_connection_are_still_transactional(monkeypatch, fresh_database_url) -> None:
    """The pool restores the default isolation when a read connection returns."""

    monkeypatch.delenv("AGENT_SERVER_DB_NULL_POOL", raising=False)
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_SIZE", "1")
    monkeypatch.setenv("AGENT_SERVER_DB_MAX_OVERFLOW", "0")

    async def run() -> None:
        engine = build_engine(url=fresh_database_url)
        try:
            async with engine.begin() as conn:
                await conn.execute(text("CREATE TABLE probe (v int)"))
            async with read_connection(engine) as conn:
                await conn.execute(text("SELECT count(*) FROM probe"))
            try:
                async with engine.begin() as conn:  # same pooled connection
                    await conn.execute(text("INSERT INTO probe VALUES (1)"))
                    raise RuntimeError("abort")
            except RuntimeError:
                pass
            async with read_connection(engine) as conn:
                assert (await conn.execute(text("SELECT count(*) FROM probe"))).scalar_one() == 0
        finally:
            await engine.dispose()

    asyncio.run(run())
