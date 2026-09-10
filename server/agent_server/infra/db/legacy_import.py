from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import func, inspect, select
from sqlalchemy.engine import Connection, create_engine
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from agent_server.infra.db.engine import POSTGRES_BACKEND, resolve_db_url
from agent_server.infra.db.migrations import (
    CURRENT_SCHEMA_REVISION,
    LEGACY_V1_REVISION,
    DatabaseMigrationError,
    classify_database,
    database_revision,
    migration_lock_timeout,
    postgres_migration_lock,
    upgrade_database,
)
from agent_server.infra.db.schema import metadata

IMPORT_BATCH_SIZE = 500


@dataclass(frozen=True, slots=True)
class TableImportReport:
    rows: int
    sha256: str


@dataclass(frozen=True, slots=True)
class LegacyImportReport:
    sourceKind: str
    sourceRevision: str
    targetRevision: str
    totalRows: int
    tables: dict[str, TableImportReport]
    preservedLegacyTables: list[str]

    def to_json(self) -> str:
        return json.dumps(
            asdict(self),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )


def rehearse_v1_import(
    *,
    source_sqlite: Path,
    target_url: str,
) -> LegacyImportReport:
    source_sqlite = source_sqlite.expanduser().resolve()
    if not source_sqlite.is_file():
        raise DatabaseMigrationError(
            f"legacy SQLite source does not exist: {source_sqlite}"
        )
    target_backend, resolved_target_url = resolve_db_url(url=target_url)
    if target_backend != POSTGRES_BACKEND:
        raise DatabaseMigrationError(
            "v1 rehearsal target must be a PostgreSQL database"
        )

    with tempfile.TemporaryDirectory(prefix="agents-anywhere-v1-rehearsal-") as tmp:
        migrated_copy = Path(tmp) / "legacy-copy.sqlite3"
        _backup_sqlite(source_sqlite, migrated_copy)
        source_url = f"sqlite+aiosqlite:///{migrated_copy}"
        initial = asyncio.run(classify_database(source_url))
        if not (
            initial.kind == "v1"
            or (initial.kind == "versioned" and initial.revision == LEGACY_V1_REVISION)
        ):
            raise DatabaseMigrationError(
                "source must be an unversioned v1 database or revision v1_legacy"
            )

        upgrade_database(db_url=source_url)
        upgrade_database(db_url=resolved_target_url)
        timeout = migration_lock_timeout()
        with postgres_migration_lock(resolved_target_url, timeout_seconds=timeout):
            tables, preserved = asyncio.run(
                _copy_and_verify(migrated_copy, resolved_target_url)
            )

    return LegacyImportReport(
        sourceKind=initial.kind,
        sourceRevision=CURRENT_SCHEMA_REVISION,
        targetRevision=CURRENT_SCHEMA_REVISION,
        totalRows=sum(table.rows for table in tables.values()),
        tables=tables,
        preservedLegacyTables=preserved,
    )


def _backup_sqlite(source: Path, destination: Path) -> None:
    source_uri = f"file:{source.as_posix()}?mode=ro"
    with (
        sqlite3.connect(source_uri, uri=True) as source_connection,
        sqlite3.connect(destination) as destination_connection,
    ):
        source_connection.backup(destination_connection)


async def _copy_and_verify(
    source_path: Path,
    target_url: str,
) -> tuple[dict[str, TableImportReport], list[str]]:
    source_engine = create_engine(f"sqlite:///{source_path}")
    target_engine = create_async_engine(target_url)
    try:
        revision = await database_revision(target_engine)
        if revision != CURRENT_SCHEMA_REVISION:
            raise DatabaseMigrationError(
                f"target database revision is {revision or 'unversioned'}, "
                f"expected {CURRENT_SCHEMA_REVISION}"
            )
        async with target_engine.connect() as target_connection:
            await _require_empty_target(target_connection)

        with source_engine.connect() as source_connection:
            source_report = _snapshot_source(source_connection)
            preserved = sorted(
                set(inspect(source_connection).get_table_names())
                - set(metadata.tables)
                - {"alembic_version"}
            )
            async with target_engine.begin() as target_connection:
                for table in metadata.sorted_tables:
                    await _copy_table(
                        source_connection,
                        target_connection,
                        table.name,
                    )

        async with target_engine.connect() as target_connection:
            target_report = await _snapshot_target(target_connection)
        if source_report != target_report:
            raise DatabaseMigrationError(
                "post-import verification failed: PostgreSQL rows differ from the migrated v1 copy"
            )
        return source_report, preserved
    finally:
        source_engine.dispose()
        await target_engine.dispose()


async def _require_empty_target(connection: AsyncConnection) -> None:
    nonempty: list[str] = []
    for table in metadata.sorted_tables:
        count = int(
            (
                await connection.execute(select(func.count()).select_from(table))
            ).scalar_one()
        )
        if count:
            nonempty.append(f"{table.name}={count}")
    if nonempty:
        raise DatabaseMigrationError(
            "target PostgreSQL database must be empty; found " + ", ".join(nonempty)
        )


async def _copy_table(
    source: Connection,
    target: AsyncConnection,
    table_name: str,
) -> None:
    table = metadata.tables[table_name]
    result = source.execute(select(table).order_by(*table.primary_key.columns))
    mappings = result.mappings()
    while True:
        rows = mappings.fetchmany(IMPORT_BATCH_SIZE)
        if not rows:
            return
        await target.execute(table.insert(), [dict(row) for row in rows])


def _snapshot_source(connection: Connection) -> dict[str, TableImportReport]:
    return {
        table.name: _snapshot_rows(
            connection.execute(
                select(table).order_by(*table.primary_key.columns)
            ).mappings()
        )
        for table in metadata.sorted_tables
    }


async def _snapshot_target(
    connection: AsyncConnection,
) -> dict[str, TableImportReport]:
    report: dict[str, TableImportReport] = {}
    for table in metadata.sorted_tables:
        rows = (
            await connection.execute(select(table).order_by(*table.primary_key.columns))
        ).mappings()
        report[table.name] = _snapshot_rows(rows)
    return report


def _snapshot_rows(rows: Any) -> TableImportReport:
    digest = hashlib.sha256()
    count = 0
    for row in rows:
        canonical = json.dumps(
            {key: _json_value(value) for key, value in row.items()},
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        digest.update(canonical.encode("utf-8"))
        digest.update(b"\n")
        count += 1
    return TableImportReport(rows=count, sha256=digest.hexdigest())


def _json_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"hex": value.hex()}
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value
