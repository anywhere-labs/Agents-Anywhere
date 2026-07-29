from __future__ import annotations

import asyncio
import json

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

from agent_server.infra.db.migrations import (
    CURRENT_SCHEMA_REVISION,
    DatabaseMigrationError,
    database_revision,
    require_current_database,
    upgrade_database,
)
from agent_server.infra.db.schema import metadata


def _sqlite_url(path) -> str:
    return f"sqlite+aiosqlite:///{path}"


def test_empty_database_upgrades_to_v2_0(tmp_path) -> None:
    path = tmp_path / "empty.sqlite3"

    upgrade_database(db_url=_sqlite_url(path))

    engine = create_engine(f"sqlite:///{path}")
    try:
        tables = set(inspect(engine).get_table_names())
        assert {"alembic_version", "device_runtimes", "notices", "sessions"}.issubset(
            tables
        )
    finally:
        engine.dispose()
    async_engine = create_async_engine(_sqlite_url(path))
    try:
        assert asyncio.run(database_revision(async_engine)) == CURRENT_SCHEMA_REVISION
        asyncio.run(require_current_database(async_engine))
    finally:
        asyncio.run(async_engine.dispose())


def test_unversioned_v1_database_migrates_data_without_dropping_legacy_tables(
    tmp_path,
) -> None:
    path = tmp_path / "legacy.sqlite3"
    _create_legacy_v1_database(path)

    upgrade_database(db_url=_sqlite_url(path))

    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        assert inspector.has_table("device_agent_settings")
        assert inspector.has_table("device_runtimes")
        session_columns = {
            column["name"] for column in inspector.get_columns("sessions")
        }
        assert {
            "runtime_settings_override",
            "model_selection_id",
            "permission_selection_id",
        }.issubset(session_columns)
        with engine.connect() as connection:
            session_status = connection.execute(
                text("SELECT status FROM sessions WHERE id = 'sess_legacy'")
            ).scalar_one()
            runtime = (
                connection.execute(
                    text(
                        "SELECT runtime_id, present, active, status, discovery_json, config_json "
                        "FROM device_runtimes WHERE connector_id = 'conn_legacy'"
                    )
                )
                .mappings()
                .one()
            )
            revision = connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
        assert session_status == "blocked"
        assert revision == CURRENT_SCHEMA_REVISION
        assert runtime["runtime_id"] == "codex"
        assert runtime["present"] == 1
        assert runtime["active"] == 1
        assert runtime["status"] == "unknown"
        assert (
            json.loads(runtime["discovery_json"])["selected"] == "/usr/local/bin/codex"
        )
        assert json.loads(runtime["config_json"]) == {}
    finally:
        engine.dispose()


def test_unversioned_v2_database_is_stamped_without_rebuilding(tmp_path) -> None:
    path = tmp_path / "unversioned-v2.sqlite3"
    engine = create_engine(f"sqlite:///{path}")
    metadata.create_all(engine)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO connectors "
                    "(id, user_id, name, status, token_hash, token_prefix, revoked, created_at, updated_at) "
                    "VALUES ('conn_v2', 'user_v2', 'Current', 'offline', 'hash', 'cxt_', 0, :now, :now)"
                ),
                {"now": "2026-07-22T00:00:00Z"},
            )
    finally:
        engine.dispose()

    upgrade_database(db_url=_sqlite_url(path))

    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.connect() as connection:
            revision = connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
            connector_name = connection.execute(
                text("SELECT name FROM connectors WHERE id = 'conn_v2'")
            ).scalar_one()
        assert revision == CURRENT_SCHEMA_REVISION
        assert connector_name == "Current"
    finally:
        engine.dispose()


def test_unknown_unversioned_database_is_rejected(tmp_path) -> None:
    path = tmp_path / "unknown.sqlite3"
    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE unrelated (id TEXT PRIMARY KEY)"))
    finally:
        engine.dispose()

    with pytest.raises(DatabaseMigrationError, match="does not match"):
        upgrade_database(db_url=_sqlite_url(path))


def _create_legacy_v1_database(path) -> None:
    engine = create_engine(f"sqlite:///{path}")
    metadata.create_all(engine)
    with engine.begin() as connection:
        connection.execute(text("DROP TABLE notices"))
        connection.execute(text("DROP TABLE connector_protocol_capabilities"))
        connection.execute(text("DROP TABLE connector_runtime_catalogs"))
        connection.execute(text("DROP TABLE device_runtimes"))
        connection.execute(
            text("ALTER TABLE connectors ADD COLUMN runtime_capabilities TEXT")
        )
        connection.execute(
            text("ALTER TABLE sessions ADD COLUMN runtime_settings_override TEXT")
        )
        connection.execute(text("ALTER TABLE sessions DROP COLUMN model_selection_id"))
        connection.execute(
            text("ALTER TABLE sessions DROP COLUMN permission_selection_id")
        )
        connection.execute(
            text(
                "CREATE TABLE device_agent_settings ("
                "connector_id TEXT NOT NULL, runtime TEXT NOT NULL, settings_json TEXT NOT NULL, "
                "schema_version INTEGER NOT NULL, updated_at TEXT NOT NULL, "
                "PRIMARY KEY (connector_id, runtime))"
            )
        )
        connection.execute(
            text(
                "INSERT INTO connectors "
                "(id, user_id, name, status, token_hash, token_prefix, revoked, created_at, updated_at, "
                "runtime_capabilities) VALUES "
                "('conn_legacy', 'user_legacy', 'Legacy', 'offline', 'hash', 'cxt_', 0, :now, :now, :state)"
            ),
            {
                "now": "2026-07-20T00:00:00Z",
                "state": json.dumps(
                    {
                        "version": 3,
                        "lastDiscoveredAt": "2026-07-20T00:00:00Z",
                        "observed": {
                            "codex": {
                                "report": {
                                    "selected": "/usr/local/bin/codex",
                                    "execution": "ok",
                                },
                                "observedAt": "2026-07-20T00:00:00Z",
                            }
                        },
                        "desired": {
                            "codex": {
                                "enabled": True,
                                "updatedAt": "2026-07-20T00:00:00Z",
                            }
                        },
                    }
                ),
            },
        )
        connection.execute(
            text(
                "INSERT INTO sessions "
                "(id, connector_id, runtime, origin, external_session_id, status, takeover, pinned, "
                "archived, last_read_seq, seq, updated_seq, created_at, updated_at, runtime_settings_override) "
                "VALUES ('sess_legacy', 'conn_legacy', 'codex', 'connector_import', 'thread_legacy', "
                "'waiting_approval', 0, 0, 0, 0, 1, 1, :now, :now, :settings)"
            ),
            {
                "now": "2026-07-20T00:00:00Z",
                "settings": json.dumps({"model": "gpt-5.4", "permissionMode": "ask"}),
            },
        )
        connection.execute(
            text(
                "INSERT INTO device_agent_settings "
                "(connector_id, runtime, settings_json, schema_version, updated_at) "
                "VALUES ('conn_legacy', 'codex', :settings, 3, :now)"
            ),
            {
                "settings": json.dumps({"model": "gpt-5.4", "permissionMode": "ask"}),
                "now": "2026-07-20T00:00:00Z",
            },
        )
