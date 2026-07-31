from __future__ import annotations

import argparse
import asyncio
import os
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager, nullcontext, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from alembic import command
from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine
from sqlalchemy.pool import NullPool

from agent_server.infra.db.engine import POSTGRES_BACKEND, resolve_db_url

LEGACY_V1_REVISION = "v1_legacy"
BASELINE_V2_REVISION = "v2_0"
CURRENT_SCHEMA_REVISION = "v2_4"
CURRENT_SCHEMA_VERSION = "2.4"
POSTGRES_MIGRATION_LOCK_ID = 0x414147454E545332
DEFAULT_MIGRATION_LOCK_TIMEOUT_SECONDS = 120.0


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
    backend, resolved_url = resolve_db_url(url=db_url, sqlite_path=sqlite_path)
    timeout = migration_lock_timeout()
    with _migration_lock(backend, resolved_url, timeout_seconds=timeout):
        state = asyncio.run(classify_database(resolved_url))
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


@contextmanager
def _migration_lock(
    backend: str,
    db_url: str,
    *,
    timeout_seconds: float,
) -> Iterator[None]:
    if backend == POSTGRES_BACKEND:
        with postgres_migration_lock(db_url, timeout_seconds=timeout_seconds):
            yield
        return
    with nullcontext():
        yield


@contextmanager
def postgres_migration_lock(
    db_url: str,
    *,
    timeout_seconds: float,
) -> Iterator[None]:
    acquired = threading.Event()
    release = threading.Event()
    errors: list[BaseException] = []

    async def hold() -> None:
        engine = create_async_engine(db_url, poolclass=NullPool)
        try:
            async with engine.connect() as connection:
                deadline = time.monotonic() + timeout_seconds
                while True:
                    locked = bool(
                        (
                            await connection.execute(
                                text("SELECT pg_try_advisory_lock(:lock_id)"),
                                {"lock_id": POSTGRES_MIGRATION_LOCK_ID},
                            )
                        ).scalar_one()
                    )
                    if locked:
                        break
                    if time.monotonic() >= deadline:
                        raise DatabaseMigrationError(
                            "timed out waiting for the PostgreSQL migration lock"
                        )
                    await asyncio.sleep(0.1)
                acquired.set()
                await asyncio.to_thread(release.wait)
                with suppress(Exception):
                    await connection.execute(
                        text("SELECT pg_advisory_unlock(:lock_id)"),
                        {"lock_id": POSTGRES_MIGRATION_LOCK_ID},
                    )
        except BaseException as exc:  # noqa: BLE001 - relayed to the caller
            errors.append(exc)
        finally:
            acquired.set()
            await engine.dispose()

    thread = threading.Thread(
        target=lambda: asyncio.run(hold()),
        name="postgres-migration-lock",
        daemon=True,
    )
    thread.start()
    if not acquired.wait(timeout_seconds + 5):
        release.set()
        thread.join(timeout=5)
        raise DatabaseMigrationError(
            "timed out starting the PostgreSQL migration lock holder"
        )
    if errors:
        thread.join(timeout=5)
        raise errors[0]
    try:
        yield
    finally:
        release.set()
        thread.join(timeout=10)
        if thread.is_alive():
            raise DatabaseMigrationError(
                "PostgreSQL migration lock holder did not shut down"
            )
        if errors:
            raise errors[0]


def migration_lock_timeout() -> float:
    raw = os.environ.get("AGENT_SERVER_MIGRATION_LOCK_TIMEOUT", "120")
    try:
        timeout = float(raw)
    except ValueError as exc:
        raise DatabaseMigrationError(
            "AGENT_SERVER_MIGRATION_LOCK_TIMEOUT must be a number"
        ) from exc
    if timeout <= 0:
        raise DatabaseMigrationError(
            "AGENT_SERVER_MIGRATION_LOCK_TIMEOUT must be greater than zero"
        )
    return timeout


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
            lambda sync_connection: MigrationContext.configure(
                sync_connection
            ).get_current_revision()
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


async def classify_database(db_url: str) -> UnversionedDatabase:
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
        "device_runtimes",
        "notices",
    }.issubset(tables) and {"model_selection_id", "permission_selection_id"}.issubset(
        session_columns
    ):
        current_layout = (
            "approvals" not in tables
            and {"presence_instance_id", "presence_connection_id"}.issubset(
                connector_columns
            )
            and "runtime_capabilities" not in connector_columns
            and "runtime_settings_override" not in session_columns
        )
        if current_layout:
            return UnversionedDatabase("v2", CURRENT_SCHEMA_REVISION)
        if "approvals" in tables:
            if {"presence_instance_id", "presence_connection_id"}.issubset(
                connector_columns
            ):
                revision = "v2_2" if "legacy_import_archive" in tables else "v2_1"
            else:
                revision = BASELINE_V2_REVISION
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
    parser = argparse.ArgumentParser(
        description="Manage the Agents Anywhere database schema"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    upgrade_parser = subparsers.add_parser(
        "upgrade", help="upgrade through every revision to the target"
    )
    upgrade_parser.add_argument("revision", nargs="?", default="head")
    current_parser = subparsers.add_parser(
        "current", help="print the current database schema version"
    )
    current_parser.add_argument("--verbose", action="store_true")
    rehearsal_parser = subparsers.add_parser(
        "rehearse-v1",
        help="copy a legacy v1 SQLite database into an empty PostgreSQL v2 database",
    )
    rehearsal_parser.add_argument("--source-sqlite", required=True)
    rehearsal_parser.add_argument("--target-url", required=True)
    rehearsal_parser.add_argument("--report")
    args = parser.parse_args()

    if args.command == "upgrade":
        upgrade_database(revision=args.revision)
        print(
            f"database schema is now {CURRENT_SCHEMA_VERSION} ({CURRENT_SCHEMA_REVISION})"
        )
        return

    if args.command == "rehearse-v1":
        from agent_server.infra.db.legacy_import import rehearse_v1_import

        try:
            report = rehearse_v1_import(
                source_sqlite=Path(args.source_sqlite),
                target_url=args.target_url,
            )
        except DatabaseMigrationError as exc:
            raise SystemExit(f"migration rehearsal failed: {exc}") from exc
        rendered = report.to_json()
        if args.report:
            Path(args.report).write_text(rendered + "\n", encoding="utf-8")
        print(rendered)
        return

    _, db_url = resolve_db_url()
    state = asyncio.run(classify_database(db_url))
    revision = state.revision if state.kind == "versioned" else None
    if args.verbose:
        print(
            f"schemaVersion={schema_version_for_revision(revision)} revision={revision or state.kind}"
        )
    else:
        print(schema_version_for_revision(revision))


if __name__ == "__main__":
    main()
