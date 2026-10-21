"""Shared PostgreSQL setup for the benchmark scripts.

The benchmarks run against a disposable PostgreSQL database, by default the one
the test suite uses: pass ``--db-url`` or set ``AGENT_SERVER_TEST_DB_URL``. The
database name must contain ``test`` because every table is emptied before a run.
"""

from __future__ import annotations

import argparse
import os
import tempfile

from sqlalchemy import text

from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.db.schema import metadata
from agent_server.infra.repositories.facade import Store

DB_URL_ENV = "AGENT_SERVER_TEST_DB_URL"


def add_db_url_argument(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--db-url",
        default=None,
        help=f"disposable postgresql+asyncpg URL (default: {DB_URL_ENV})",
    )


def resolve_bench_db_url(url: str | None) -> str:
    url = (url or os.environ.get(DB_URL_ENV, "")).strip()
    if not url:
        raise SystemExit(
            f"pass --db-url or set {DB_URL_ENV} to a disposable postgresql+asyncpg URL"
        )
    if not url.startswith("postgresql"):
        raise SystemExit("the benchmark database must be a postgresql+asyncpg URL")
    database = url.rsplit("/", 1)[-1].split("?", 1)[0]
    if "test" not in database:
        raise SystemExit(
            "the benchmark empties every table, so the database name must "
            f"contain 'test'; got {database!r}"
        )
    return url


async def open_bench_store(url: str) -> Store:
    """Migrate the disposable database, empty it and return a ``Store`` on it."""
    upgrade_database(db_url=url)
    # Keep attachment scratch out of the working directory.
    os.environ.setdefault(
        "AGENT_SERVER_FILES_LOCAL_ROOT", tempfile.mkdtemp(prefix="aa-bench-")
    )
    store = Store(db_url=url)
    tables = ", ".join(sorted(table.name for table in metadata.sorted_tables))
    async with store.engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE TABLE {tables} RESTART IDENTITY CASCADE"))
    return store
