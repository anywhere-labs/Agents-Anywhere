from __future__ import annotations

import argparse
import asyncio
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from agent_server.infra.db.engine import resolve_db_url

LEGACY_V1_REVISION = "v1_legacy"
BASELINE_V2_REVISION = "v2_0"
CURRENT_SCHEMA_REVISION = "v2_1"
CURRENT_SCHEMA_VERSION = "2.1"


class DatabaseMigrationError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class UnversionedDatabase:
    kind: Literal["empty", "v1", "v2", "unknown", "versioned"]
    revision: str | None = None


def upgrade_database(
    *,
    sqlite_path: str | Path | None = None,
    db_url: str | None = None,
    revision: str = "head",
) -> None:
    _run_outside_event_loop(
        lambda: _upgrade_database(
            sqlite_path=sqlite_path,
            db_url=db_url,
            revision=revision,
        )
    )


def _upgrade_database(
    *,
    sqlite_path: str | Path | None,
    db_url: str | None,
    revision: str,
) -> None:
    _, resolved_url = resolve_db_url(url=db_url, sqlite_path=sqlite_path)
    state = asyncio.run(_classify_database(resolved_url))
    config = _alembic_config(resolved_url)
    if state.kind == "v1":
        command.stamp(config, LEGACY_V1_REVISION)
    elif state.kind == "v2":
        command.stamp(config, state.revision or BASELINE_V2_REVISION)
    elif state.kind == "unknown":
        raise DatabaseMigrationError(
            "database has no Alembic version and does not match a supported v1 or v2 schema"
        )
    command.upgrade(config, revision)


def _run_outside_event_loop(operation) -> None:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        operation()
        return

    errors: list[BaseException] = []

    def run() -> None:
        try:
            operation()
        except BaseException as exc:  # noqa: BLE001 - re-raised in caller
            errors.append(exc)

    thread = threading.Thread(target=run, name="database-migration")
    thread.start()
    thread.join()
    if errors:
        raise errors[0]


async def database_revision(engine: AsyncEngine) -> str | None:
    async with engine.connect() as connection:
        return await connection.run_sync(
            lambda sync_connection: MigrationContext.configure(sync_connection).get_current_revision()
        )


async def database_schema_version(engine: AsyncEngine) -> str:
    revision = await database_revision(engine)
    return schema_version_for_revision(revision)


async def require_current_database(engine: AsyncEngine) -> None:
    revision = await database_revision(engine)
    if revision == CURRENT_SCHEMA_REVISION:
        return
    if revision is None:
        raise DatabaseMigrationError(
            "database is not versioned; run `uv run python -m "
            "agent_server.infra.db.migrations upgrade` before starting the server"
        )
    raise DatabaseMigrationError(
        f"database schema revision is {revision}, but this server requires {CURRENT_SCHEMA_REVISION}; "
        "run `uv run python -m agent_server.infra.db.migrations upgrade`"
    )


def schema_version_for_revision(revision: str | None) -> str:
    if revision is None:
        return "unversioned"
    if revision == LEGACY_V1_REVISION:
        return "1.legacy"
    if revision.startswith("v") and "_" in revision:
        major, minor = revision[1:].split("_", 1)
        if major.isdigit() and minor.isdigit():
            return f"{int(major)}.{int(minor)}"
    return revision


def _alembic_config(db_url: str) -> Config:
    server_root = Path(__file__).resolve().parents[3]
    config = Config(str(server_root / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", db_url.replace("%", "%%"))
    return config


async def _classify_database(db_url: str) -> UnversionedDatabase:
    engine = create_async_engine(db_url)
    try:
        async with engine.connect() as connection:
            return await connection.run_sync(_classify_sync)
    finally:
        await engine.dispose()


def _classify_sync(connection) -> UnversionedDatabase:
    inspector = inspect(connection)
    tables = set(inspector.get_table_names())
    if "alembic_version" in tables:
        revision = MigrationContext.configure(connection).get_current_revision()
        return UnversionedDatabase("versioned", revision)
    if not tables:
        return UnversionedDatabase("empty")

    session_columns = _column_names(inspector, "sessions")
    connector_columns = _column_names(inspector, "connectors")
    if {
        "connectors",
        "sessions",
        "timeline_items",
        "approvals",
        "device_runtimes",
        "notices",
    }.issubset(tables) and {"model_selection_id", "permission_selection_id"}.issubset(session_columns):
        revision = (
            CURRENT_SCHEMA_REVISION
            if {"presence_instance_id", "presence_connection_id"}.issubset(connector_columns)
            else BASELINE_V2_REVISION
        )
        return UnversionedDatabase("v2", revision)
    if {
        "connectors",
        "sessions",
        "timeline_items",
        "approvals",
        "device_agent_settings",
    }.issubset(tables) and "runtime_capabilities" in connector_columns:
        return UnversionedDatabase("v1")
    return UnversionedDatabase("unknown")


def _column_names(inspector, table: str) -> set[str]:
    if table not in inspector.get_table_names():
        return set()
    return {str(column["name"]) for column in inspector.get_columns(table)}


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage the Agents Anywhere database schema")
    subparsers = parser.add_subparsers(dest="command", required=True)
    upgrade_parser = subparsers.add_parser("upgrade", help="upgrade through every revision to the target")
    upgrade_parser.add_argument("revision", nargs="?", default="head")
    current_parser = subparsers.add_parser("current", help="print the current database schema version")
    current_parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.command == "upgrade":
        upgrade_database(revision=args.revision)
        print(f"database schema is now {CURRENT_SCHEMA_VERSION} ({CURRENT_SCHEMA_REVISION})")
        return

    _, db_url = resolve_db_url()
    state = asyncio.run(_classify_database(db_url))
    revision = state.revision if state.kind == "versioned" else None
    if args.verbose:
        print(f"schemaVersion={schema_version_for_revision(revision)} revision={revision or state.kind}")
    else:
        print(schema_version_for_revision(revision))


if __name__ == "__main__":
    main()
