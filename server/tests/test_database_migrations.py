from __future__ import annotations

import asyncio
import hashlib
import json

import pytest
from alembic import command
from sqlalchemy import BigInteger, create_engine, inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

from agent_server.infra.db.engine import build_engine, resolve_db_url
from agent_server.infra.db.legacy_import import rehearse_v1_import
from agent_server.infra.db.migrations import (
    CURRENT_SCHEMA_REVISION,
    CURRENT_SCHEMA_VERSION,
    DatabaseMigrationError,
    UnversionedDatabase,
    _alembic_config,
    classify_database,
    database_revision,
    require_current_database,
    upgrade_database,
)
from agent_server.infra.db.schema import (
    connector_protocol_capabilities,
    connector_runtime_catalogs,
    connector_runtime_types,
    metadata,
    sessions,
    timeline_items,
)


def _sqlite_url(path) -> str:
    return f"sqlite+aiosqlite:///{path}"


def test_protocol_clock_revisions_use_64_bit_columns() -> None:
    assert isinstance(connector_protocol_capabilities.c.revision.type, BigInteger)
    assert isinstance(connector_runtime_catalogs.c.revision.type, BigInteger)
    assert isinstance(connector_runtime_types.c.max_instances.type, BigInteger)


def test_session_sequence_clocks_use_64_bit_columns() -> None:
    for column_name in (
        "last_read_seq",
        "latest_turn_end_seq",
        "timeline_reset_seq",
        "seq",
        "seq_allocated_high",
        "updated_seq",
    ):
        assert isinstance(sessions.c[column_name].type, BigInteger)
    assert isinstance(timeline_items.c.updated_seq.type, BigInteger)


def test_runtime_database_url_is_required(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_SERVER_DB_URL", raising=False)
    monkeypatch.delenv("AGENT_SERVER_DB_BACKEND", raising=False)
    monkeypatch.delenv("AGENT_SERVER_DB", raising=False)

    with pytest.raises(ValueError, match="AGENT_SERVER_DB_URL is required"):
        resolve_db_url()


def test_runtime_sqlite_environment_is_rejected(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SERVER_DB_URL", _sqlite_url(tmp_path / "runtime.sqlite3"))
    monkeypatch.delenv("AGENT_SERVER_DB_BACKEND", raising=False)

    with pytest.raises(
        ValueError, match="SQLite runtime configuration is no longer supported"
    ):
        resolve_db_url()


def test_explicit_sqlite_url_remains_available_for_legacy_tools(tmp_path) -> None:
    url = _sqlite_url(tmp_path / "legacy.sqlite3")

    assert resolve_db_url(url=url) == ("sqlite", url)


def test_empty_database_upgrades_to_current_schema(tmp_path) -> None:
    path = tmp_path / "empty.sqlite3"

    upgrade_database(db_url=_sqlite_url(path))

    engine = create_engine(f"sqlite:///{path}")
    try:
        tables = set(inspect(engine).get_table_names())
        assert {
            "alembic_version",
            "app_releases",
            "device_runtimes",
            "session_shares",
            "sessions",
        }.issubset(tables)
        assert "approvals" not in tables
        assert "notices" not in tables
    finally:
        engine.dispose()
    async_engine = create_async_engine(_sqlite_url(path))
    try:
        assert asyncio.run(database_revision(async_engine)) == CURRENT_SCHEMA_REVISION
        asyncio.run(require_current_database(async_engine))
    finally:
        asyncio.run(async_engine.dispose())


def test_unversioned_v1_database_archives_then_removes_legacy_storage(
    tmp_path,
) -> None:
    path = tmp_path / "legacy.sqlite3"
    _create_legacy_v1_database(path)

    upgrade_database(db_url=_sqlite_url(path))

    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        assert not inspector.has_table("device_agent_settings")
        assert not inspector.has_table("agent_modes")
        assert not inspector.has_table("approvals")
        assert inspector.has_table("device_runtimes")
        session_columns = {
            column["name"] for column in inspector.get_columns("sessions")
        }
        assert {"model_selection_id", "permission_selection_id"}.issubset(
            session_columns
        )
        assert "runtime_settings_override" not in session_columns
        connector_columns = {
            column["name"] for column in inspector.get_columns("connectors")
        }
        assert {"presence_instance_id", "presence_connection_id"}.issubset(
            connector_columns
        )
        assert "runtime_capabilities" not in connector_columns
        with engine.connect() as connection:
            session_status = connection.execute(
                text("SELECT status FROM sessions WHERE id = 'sess_legacy'")
            ).scalar_one()
            runtime = (
                connection.execute(
                    text(
                        "SELECT runtime.runtime_id, runtime_type.present, runtime.active, "
                        "runtime.status, runtime_type.discovery_json, runtime.config_json "
                        "FROM device_runtimes AS runtime "
                        "JOIN connector_runtime_types AS runtime_type "
                        "ON runtime_type.connector_id = runtime.connector_id "
                        "AND runtime_type.runtime_type = runtime.runtime_type "
                        "WHERE runtime.connector_id = 'conn_legacy' "
                        "AND runtime.runtime_id = 'codex'"
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
        assert json.loads(runtime["config_json"]) == {
            "model": "gpt-5.4",
            "permissionMode": "ask",
        }
        with engine.connect() as connection:
            selections = (
                connection.execute(
                    text(
                        "SELECT model_selection_id, permission_selection_id "
                        "FROM sessions WHERE id = 'sess_legacy'"
                    )
                )
                .mappings()
                .one()
            )
        assert selections == {
            "model_selection_id": "gpt-5.4",
            "permission_selection_id": "ask",
        }
        with engine.connect() as connection:
            archived_sources = set(
                connection.execute(
                    text("SELECT source_table FROM legacy_import_archive")
                ).scalars()
            )
        assert archived_sources == {
            "agent_modes",
            "connectors.runtime_capabilities",
            "device_agent_settings",
            "sessions.runtime_settings_override",
        }
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


def test_unversioned_v2_2_database_is_stamped_then_upgraded(tmp_path) -> None:
    path = tmp_path / "unversioned-v2-2.sqlite3"
    upgrade_database(db_url=_sqlite_url(path), revision="v2_2")
    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(text("DROP TABLE alembic_version"))
    finally:
        engine.dispose()

    upgrade_database(db_url=_sqlite_url(path))

    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        assert "approvals" not in inspector.get_table_names()
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == CURRENT_SCHEMA_REVISION
            )
    finally:
        engine.dispose()


@pytest.mark.parametrize("source_revision", ["v2_7", "v2_8", "v2_9"])
def test_unversioned_recent_v2_database_runs_remaining_migrations(
    tmp_path,
    source_revision: str,
) -> None:
    path = tmp_path / f"unversioned-{source_revision}.sqlite3"
    upgrade_database(db_url=_sqlite_url(path), revision=source_revision)
    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(text("DROP TABLE alembic_version"))
    finally:
        engine.dispose()

    upgrade_database(db_url=_sqlite_url(path))

    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        assert "timeline_reset_seq" in {
            column["name"] for column in inspector.get_columns("sessions")
        }
        assert "turn_id" not in {
            column["name"] for column in inspector.get_columns("session_active_runs")
        }
        assert "turn_id" not in {
            column["name"] for column in inspector.get_columns("timeline_items")
        }
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == CURRENT_SCHEMA_REVISION
            )
    finally:
        engine.dispose()


def test_v2_0_database_upgrades_through_current_revision(tmp_path) -> None:
    path = tmp_path / "versioned-v2-0.sqlite3"
    upgrade_database(db_url=_sqlite_url(path), revision="v2_0")

    engine = create_engine(f"sqlite:///{path}")
    try:
        columns = {
            column["name"] for column in inspect(engine).get_columns("connectors")
        }
        assert "presence_connection_id" not in columns
    finally:
        engine.dispose()

    upgrade_database(db_url=_sqlite_url(path))

    engine = create_engine(f"sqlite:///{path}")
    try:
        columns = {
            column["name"] for column in inspect(engine).get_columns("connectors")
        }
        assert {"presence_instance_id", "presence_connection_id"}.issubset(columns)
        assert "approvals" not in inspect(engine).get_table_names()
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == CURRENT_SCHEMA_REVISION
            )
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    ("source_revision", "target_revision"),
    [
        ("v1_legacy", "v2_0"),
        ("v2_0", "v2_1"),
        ("v2_1", "v2_2"),
        ("v2_2", "v2_3"),
        ("v2_3", "v2_4"),
        ("v2_4", "v2_5"),
        ("v2_5", "v2_6"),
        ("v2_6", "v2_7"),
        ("v2_7", "v2_8"),
        ("v2_8", "v2_9"),
        ("v2_9", "v2_10"),
        ("v2_10", "v2_11"),
        ("v2_11", "v2_12"),
        ("v2_12", "v2_13"),
        ("v2_13", "v2_14"),
        ("v2_14", "v2_15"),
        ("v2_15", "v2_16"),
        ("v2_16", "v2_17"),
        ("v2_17", "v2_18"),
        ("v2_18", "v2_19"),
        ("v2_19", "v2_20"),
        ("v2_20", "v2_21"),
        ("v2_21", "v2_22"),
        ("v2_22", "v2_23"),
        ("v2_23", "v2_24"),
    ],
)
def test_every_adjacent_schema_upgrade(
    tmp_path,
    source_revision: str,
    target_revision: str,
) -> None:
    path = tmp_path / f"{source_revision}-{target_revision}.sqlite3"
    upgrade_database(db_url=_sqlite_url(path), revision=source_revision)

    upgrade_database(db_url=_sqlite_url(path), revision=target_revision)

    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == target_revision
            )
    finally:
        engine.dispose()


def test_v2_8_removes_turn_id_from_active_session_runs(tmp_path) -> None:
    path = tmp_path / "v2_8-active-runs.sqlite3"
    upgrade_database(db_url=_sqlite_url(path), revision="v2_7")

    engine = create_engine(f"sqlite:///{path}")
    try:
        assert "turn_id" in {
            column["name"]
            for column in inspect(engine).get_columns("session_active_runs")
        }
    finally:
        engine.dispose()


def test_v2_9_removes_turn_data_from_timelines(tmp_path) -> None:
    path = tmp_path / "v2_9-timelines.sqlite3"
    upgrade_database(db_url=_sqlite_url(path), revision="v2_8")

    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(text("PRAGMA foreign_keys = OFF"))
            connection.execute(
                text(
                    "INSERT INTO dashboard_daily_metrics "
                    "(date, metric_key, dimension_key, dimension_value, value, computed_at) "
                    "VALUES ('2026-08-12', 'usage.turns', '', '', 3, '2026-08-12T00:00:00Z')"
                )
            )
            connection.execute(
                text(
                    "INSERT INTO dashboard_settings (key, value_json, updated_at) "
                    "VALUES ('settings', :value, '2026-08-12T00:00:00Z')"
                ),
                {
                    "value": json.dumps(
                        {
                            "intensity": {
                                "basis": "turns",
                                "lightMax": 1,
                                "mediumMax": 2,
                            },
                            "histogramBins": {"turns": [0, 1], "sessions": [0, 1]},
                        }
                    )
                },
            )
            for item_id, item_type, payload in (
                (
                    "turn_start_1",
                    "turn.start",
                    {"id": "turn_start_1", "type": "turn.start", "turnId": "turn_1"},
                ),
                (
                    "message_1",
                    "message",
                    {
                        "id": "message_1",
                        "type": "message",
                        "turnId": "turn_1",
                        "source": {"runtime": "codex", "turnId": "turn_1"},
                        "content": {"turn": "left", "text": "done"},
                    },
                ),
            ):
                connection.execute(
                    text(
                        "INSERT INTO timeline_items "
                        "(session_id, id, type, status, role, turn_id, order_seq, updated_seq, item_time, payload_json) "
                        "VALUES ('sess_1', :id, :type, 'done', NULL, 'turn_1', 1, 1, NULL, :payload)"
                    ),
                    {"id": item_id, "type": item_type, "payload": json.dumps(payload)},
                )
    finally:
        engine.dispose()

    upgrade_database(db_url=_sqlite_url(path), revision="v2_9")

    engine = create_engine(f"sqlite:///{path}")
    try:
        assert "turn_id" not in {
            column["name"] for column in inspect(engine).get_columns("timeline_items")
        }
        fact_columns = {
            column["name"]
            for column in inspect(engine).get_columns("dashboard_user_daily_facts")
        }
        assert "messages" in fact_columns
        assert "turns" not in fact_columns
        with engine.connect() as connection:
            rows = (
                connection.execute(
                    text("SELECT id, payload_json FROM timeline_items ORDER BY id")
                )
                .mappings()
                .all()
            )
            metric_key = connection.execute(
                text("SELECT metric_key FROM dashboard_daily_metrics")
            ).scalar_one()
            settings = json.loads(
                connection.execute(
                    text(
                        "SELECT value_json FROM dashboard_settings WHERE key = 'settings'"
                    )
                ).scalar_one()
            )
        assert [row["id"] for row in rows] == ["message_1"]
        assert json.loads(rows[0]["payload_json"]) == {
            "content": {"text": "done", "turn": "left"},
            "id": "message_1",
            "source": {"runtime": "codex"},
            "type": "message",
        }
        assert metric_key == "usage.messages"
        assert settings == {
            "histogramBins": {"messages": [0, 1], "sessions": [0, 1]},
            "intensity": {"basis": "messages", "lightMax": 1, "mediumMax": 2},
        }
    finally:
        engine.dispose()

    upgrade_database(db_url=_sqlite_url(path), revision="v2_8")

    engine = create_engine(f"sqlite:///{path}")
    try:
        assert "turn_id" not in {
            column["name"]
            for column in inspect(engine).get_columns("session_active_runs")
        }
    finally:
        engine.dispose()


def test_v2_10_adds_timeline_reset_watermark(tmp_path) -> None:
    path = tmp_path / "v2_10-timeline-reset.sqlite3"
    upgrade_database(db_url=_sqlite_url(path), revision="v2_9")

    engine = create_engine(f"sqlite:///{path}")
    try:
        assert "timeline_reset_seq" not in {
            column["name"] for column in inspect(engine).get_columns("sessions")
        }
    finally:
        engine.dispose()

    upgrade_database(db_url=_sqlite_url(path), revision="v2_10")

    engine = create_engine(f"sqlite:///{path}")
    try:
        columns = {
            column["name"]: column for column in inspect(engine).get_columns("sessions")
        }
        assert columns["timeline_reset_seq"]["nullable"] is False
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_10"
            )
    finally:
        engine.dispose()


def test_v2_11_adds_dsh_facts_and_runtime_metadata(tmp_path) -> None:
    path = tmp_path / "v2_11-dsh.sqlite3"
    upgrade_database(db_url=_sqlite_url(path), revision="v2_10")

    upgrade_database(db_url=_sqlite_url(path), revision="v2_11")

    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        fact_columns = {
            column["name"]
            for column in inspector.get_columns("dashboard_user_daily_facts")
        }
        runtime_columns = {
            column["name"] for column in inspector.get_columns("device_runtimes")
        }
        assert "dsh_agents" in fact_columns
        assert "inventory_metadata_json" in runtime_columns
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_11"
            )
    finally:
        engine.dispose()


def test_v2_12_adds_dsh_source_state_without_rewriting_archives(tmp_path) -> None:
    path = tmp_path / "v2_12-dsh-source-state.sqlite3"
    upgrade_database(db_url=_sqlite_url(path), revision="v2_11")
    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO connectors "
                    "(id, user_id, name, status, token_hash, token_prefix, revoked, created_at, updated_at) "
                    "VALUES ('conn_dsh_source', 'user_dsh_source', 'DSH', 'offline', "
                    "'hash', 'cxt_', 0, :now, :now)"
                ),
                {"now": "2026-08-16T00:00:00Z"},
            )
            connection.execute(
                text(
                    "INSERT INTO sessions "
                    "(id, connector_id, runtime, origin, status, takeover, pinned, archived, "
                    "last_read_seq, seq, updated_seq, created_at, updated_at) "
                    "VALUES ('sess_dsh_source', 'conn_dsh_source', 'dsh', 'connector_import', "
                    "'idle', 0, 0, 1, 0, 1, 1, :now, :now)"
                ),
                {"now": "2026-08-16T00:00:00Z"},
            )
    finally:
        engine.dispose()

    upgrade_database(db_url=_sqlite_url(path), revision="v2_12")

    engine = create_engine(f"sqlite:///{path}")
    try:
        columns = {column["name"] for column in inspect(engine).get_columns("sessions")}
        assert {"source_state", "source_state_at", "source_scan_token"}.issubset(
            columns
        )
        with engine.connect() as connection:
            row = connection.execute(
                text(
                    "SELECT archived, source_state, source_state_at, source_scan_token "
                    "FROM sessions WHERE id = 'sess_dsh_source'"
                )
            ).one()
            assert tuple(row) == (1, "visible", None, None)
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_12"
            )
    finally:
        engine.dispose()


def test_v2_13_marks_only_existing_dsh_archives_as_legacy(tmp_path) -> None:
    path = tmp_path / "v2_13-dsh-legacy-archive.sqlite3"
    upgrade_database(db_url=_sqlite_url(path), revision="v2_12")
    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO connectors "
                    "(id, user_id, name, status, token_hash, token_prefix, revoked, created_at, updated_at) "
                    "VALUES ('conn_dsh_legacy', 'user_dsh_legacy', 'DSH', 'offline', "
                    "'hash', 'cxt_', 0, :now, :now)"
                ),
                {"now": "2026-08-16T00:00:00Z"},
            )
            for session_id, runtime, archived in (
                ("sess_dsh_archived", "dsh", 1),
                ("sess_dsh_active", "dsh", 0),
                ("sess_codex_archived", "codex", 1),
            ):
                connection.execute(
                    text(
                        "INSERT INTO sessions "
                        "(id, connector_id, runtime, origin, status, takeover, pinned, archived, "
                        "last_read_seq, seq, updated_seq, created_at, updated_at) "
                        "VALUES (:id, 'conn_dsh_legacy', :runtime, 'connector_import', "
                        "'idle', 0, 0, :archived, 0, 1, 1, :now, :now)"
                    ),
                    {
                        "id": session_id,
                        "runtime": runtime,
                        "archived": archived,
                        "now": "2026-08-16T00:00:00Z",
                    },
                )
    finally:
        engine.dispose()

    upgrade_database(db_url=_sqlite_url(path), revision="v2_13")

    engine = create_engine(f"sqlite:///{path}")
    try:
        columns = {column["name"] for column in inspect(engine).get_columns("sessions")}
        assert "dsh_archive_legacy" in columns
        with engine.connect() as connection:
            rows = connection.execute(
                text(
                    "SELECT id, archived, dsh_archive_legacy FROM sessions ORDER BY id"
                )
            ).all()
            assert [tuple(row) for row in rows] == [
                ("sess_codex_archived", 1, 0),
                ("sess_dsh_active", 0, 0),
                ("sess_dsh_archived", 1, 1),
            ]
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_13"
            )
    finally:
        engine.dispose()


def test_v2_14_splits_runtime_storage_without_losing_dsh_state(tmp_path) -> None:
    path = tmp_path / "v2_14-runtime-instances.sqlite3"
    _seed_v2_13_runtime_storage(path)

    upgrade_database(db_url=_sqlite_url(path), revision="v2_14")

    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        assert inspector.has_table("connector_runtime_types")
        assert "runtime_control_version" in {
            column["name"] for column in inspector.get_columns("connectors")
        }
        assert {"runtime_id"}.issubset(
            column["name"] for column in inspector.get_columns("sessions")
        )
        assert {"runtime_id"}.issubset(
            column["name"] for column in inspector.get_columns("session_active_runs")
        )
        assert inspector.get_pk_constraint("connector_runtime_catalogs")[
            "constrained_columns"
        ] == ["connector_id", "runtime_id", "catalog_type"]

        with engine.connect() as connection:
            assert (
                connection.execute(
                    text(
                        "SELECT runtime_control_version FROM connectors "
                        "WHERE id = 'conn_runtime_storage'"
                    )
                ).scalar_one()
                == "1.0"
            )
            type_rows = (
                connection.execute(
                    text(
                        "SELECT runtime_type, implementation_type, display_name, "
                        "present, available, discovery_json, metadata_json, "
                        "instance_policy, max_instances "
                        "FROM connector_runtime_types "
                        "WHERE connector_id = 'conn_runtime_storage' "
                        "ORDER BY runtime_type"
                    )
                )
                .mappings()
                .all()
            )
            instance_rows = (
                connection.execute(
                    text(
                        "SELECT runtime_id, runtime_type, name, name_key, config_json, "
                        "active, status, error_json, created_at, updated_at "
                        "FROM device_runtimes "
                        "WHERE connector_id = 'conn_runtime_storage' "
                        "ORDER BY runtime_id"
                    )
                )
                .mappings()
                .all()
            )
            session = (
                connection.execute(
                    text(
                        "SELECT runtime, runtime_id, archived, archived_at, "
                        "dsh_archive_legacy, source_state, source_state_at, "
                        "source_scan_token, last_read_seq, timeline_reset_seq "
                        "FROM sessions WHERE id = 'sess_runtime_storage'"
                    )
                )
                .mappings()
                .one()
            )
            active_run = (
                connection.execute(
                    text(
                        "SELECT runtime, runtime_id, external_session_id, status, "
                        "params_json FROM session_active_runs "
                        "WHERE session_id = 'sess_runtime_storage'"
                    )
                )
                .mappings()
                .one()
            )
            catalog = (
                connection.execute(
                    text(
                        "SELECT runtime, runtime_id, catalog_type, revision, catalog_json "
                        "FROM connector_runtime_catalogs "
                        "WHERE connector_id = 'conn_runtime_storage'"
                    )
                )
                .mappings()
                .one()
            )

        assert [row["runtime_type"] for row in type_rows] == ["codex", "dsh"]
        dsh_type = type_rows[1]
        assert dsh_type["implementation_type"] == "local-service"
        assert dsh_type["display_name"] == "Shared Runtime"
        assert (dsh_type["present"], dsh_type["available"]) == (1, 1)
        assert json.loads(dsh_type["discovery_json"]) == {"endpoint": "/tmp/dsh.sock"}
        assert json.loads(dsh_type["metadata_json"]) == {
            "bridgeVersion": "0.1.0",
            "storageMode": "local",
        }
        assert (dsh_type["instance_policy"], dsh_type["max_instances"]) == (
            "single",
            1,
        )

        assert [row["runtime_id"] for row in instance_rows] == ["codex", "dsh"]
        assert instance_rows[0]["name"] == "Shared Runtime"
        dsh_instance = instance_rows[1]
        assert dsh_instance["runtime_type"] == "dsh"
        assert dsh_instance["name"] == "Shared Runtime (dsh)"
        assert dsh_instance["name_key"] == "shared runtime (dsh)"
        assert dsh_instance["config_json"] is None
        assert dsh_instance["active"] == 0
        assert dsh_instance["status"] == "error"
        assert json.loads(dsh_instance["error_json"]) == {"code": "bridge_unavailable"}
        assert dsh_instance["created_at"] == "2026-08-24T13:38:00Z"
        assert dsh_instance["updated_at"] == "2026-08-24T13:38:00Z"

        assert dict(session) == {
            "runtime": "dsh",
            "runtime_id": "dsh",
            "archived": 1,
            "archived_at": "2026-08-24T13:40:00Z",
            "dsh_archive_legacy": 1,
            "source_state": "missing",
            "source_state_at": "2026-08-24T13:41:00Z",
            "source_scan_token": "scan-preserved",
            "last_read_seq": 7,
            "timeline_reset_seq": 8,
        }
        assert dict(active_run) == {
            "runtime": "dsh",
            "runtime_id": "dsh",
            "external_session_id": "dsh_external",
            "status": "running",
            "params_json": '{"model":"deepseek"}',
        }
        assert dict(catalog) == {
            "runtime": "dsh",
            "runtime_id": "dsh",
            "catalog_type": "model",
            "revision": 17,
            "catalog_json": '{"models":["deepseek"]}',
        }
    finally:
        engine.dispose()


def test_v2_14_compatible_data_downgrades_to_v2_13(tmp_path) -> None:
    path = tmp_path / "v2_14-compatible-downgrade.sqlite3"
    _seed_v2_13_runtime_storage(path)
    url = _sqlite_url(path)
    upgrade_database(db_url=url, revision="v2_14")

    command.downgrade(_alembic_config(url), "v2_13")

    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        assert not inspector.has_table("connector_runtime_types")
        assert "runtime_control_version" not in {
            column["name"] for column in inspector.get_columns("connectors")
        }
        assert "runtime_id" not in {
            column["name"] for column in inspector.get_columns("sessions")
        }
        assert "runtime_id" not in {
            column["name"] for column in inspector.get_columns("session_active_runs")
        }
        assert inspector.get_pk_constraint("connector_runtime_catalogs")[
            "constrained_columns"
        ] == ["connector_id", "runtime", "catalog_type"]
        with engine.connect() as connection:
            runtime = (
                connection.execute(
                    text(
                        "SELECT runtime_id, runtime_type, display_name, "
                        "inventory_metadata_json, config_json, active, status, error_json "
                        "FROM device_runtimes "
                        "WHERE connector_id = 'conn_runtime_storage' AND runtime_id = 'dsh'"
                    )
                )
                .mappings()
                .one()
            )
            session = (
                connection.execute(
                    text(
                        "SELECT runtime, archived, dsh_archive_legacy, source_state, "
                        "source_scan_token FROM sessions "
                        "WHERE id = 'sess_runtime_storage'"
                    )
                )
                .mappings()
                .one()
            )
            revision = connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
        assert runtime["runtime_type"] == "local-service"
        assert runtime["display_name"] == "Shared Runtime (dsh)"
        assert json.loads(runtime["inventory_metadata_json"])["storageMode"] == (
            "local"
        )
        assert runtime["config_json"] is None
        assert runtime["active"] == 0
        assert runtime["status"] == "error"
        assert json.loads(runtime["error_json"])["code"] == "bridge_unavailable"
        assert dict(session) == {
            "runtime": "dsh",
            "archived": 1,
            "dsh_archive_legacy": 1,
            "source_state": "missing",
            "source_scan_token": "scan-preserved",
        }
        assert revision == "v2_13"
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "incompatible_sql",
    [
        pytest.param(
            "INSERT INTO device_runtimes "
            "(connector_id, runtime_id, runtime_type, name, name_key, config_json, "
            "active, status, error_json, created_at, updated_at) VALUES "
            "('conn_runtime_storage', 'rti_named', 'dsh', 'Named DSH', "
            "'named dsh', NULL, 0, 'stopped', NULL, "
            "'2026-08-24T13:50:00Z', '2026-08-24T13:50:00Z')",
            id="named-instance",
        ),
        pytest.param(
            "UPDATE sessions SET runtime_id = 'rti_session' "
            "WHERE id = 'sess_runtime_storage'",
            id="session-binding",
        ),
        pytest.param(
            "UPDATE session_active_runs SET runtime_id = 'rti_run' "
            "WHERE session_id = 'sess_runtime_storage'",
            id="active-run-binding",
        ),
        pytest.param(
            "UPDATE connector_runtime_catalogs SET runtime_id = 'rti_catalog' "
            "WHERE connector_id = 'conn_runtime_storage'",
            id="catalog-binding",
        ),
    ],
)
def test_v2_14_downgrade_rejects_instance_specific_data(
    tmp_path,
    incompatible_sql: str,
) -> None:
    path = tmp_path / "v2_14-incompatible-downgrade.sqlite3"
    _seed_v2_13_runtime_storage(path)
    url = _sqlite_url(path)
    upgrade_database(db_url=url, revision="v2_14")
    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(text(incompatible_sql))
    finally:
        engine.dispose()

    with pytest.raises(RuntimeError, match="cannot downgrade v2_14"):
        command.downgrade(_alembic_config(url), "v2_13")

    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_14"
            )
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "revision",
    [
        "v2_10",
        "v2_11",
        "v2_12",
        "v2_13",
        "v2_14",
        "v2_15",
        "v2_16",
        "v2_17",
        "v2_18",
        "v2_19",
        "v2_20",
        "v2_21",
        "v2_23",
        "v2_24",
    ],
)
def test_unversioned_runtime_schema_is_classified_by_actual_columns(
    tmp_path,
    revision: str,
) -> None:
    path = tmp_path / f"unversioned-{revision}.sqlite3"
    url = _sqlite_url(path)
    upgrade_database(db_url=url, revision=revision)
    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            if revision == "v2_10":
                # The immutable bootstrap schema already contains these two
                # idempotently-added v2_11 columns. Remove them to model an
                # actual historical unversioned v2_10 database.
                connection.execute(
                    text(
                        "ALTER TABLE device_runtimes "
                        "DROP COLUMN inventory_metadata_json"
                    )
                )
                connection.execute(
                    text(
                        "ALTER TABLE dashboard_user_daily_facts DROP COLUMN dsh_agents"
                    )
                )
            connection.execute(text("DROP TABLE alembic_version"))
    finally:
        engine.dispose()

    assert asyncio.run(classify_database(url)) == UnversionedDatabase(
        "v2",
        revision,
    )


def test_current_schema_version_is_v2_24() -> None:
    assert CURRENT_SCHEMA_REVISION == "v2_24"
    assert CURRENT_SCHEMA_VERSION == "2.24"


def test_v2_20_adds_session_source_observation_details(tmp_path) -> None:
    path = tmp_path / "session-source-observation.sqlite3"
    url = _sqlite_url(path)
    upgrade_database(db_url=url, revision="v2_19")
    upgrade_database(db_url=url, revision="v2_20")

    engine = create_engine(f"sqlite:///{path}")
    try:
        columns = {column["name"] for column in inspect(engine).get_columns("sessions")}
    finally:
        engine.dispose()

    assert {"source_state_reason", "source_observation_origin"}.issubset(columns)


def test_v2_22_retires_session_message_queue_schema(tmp_path) -> None:
    path = tmp_path / "retired-session-message-queue.sqlite3"
    url = _sqlite_url(path)
    upgrade_database(db_url=url, revision="v2_21")

    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        assert inspector.has_table("session_message_queue")
        assert "message_queue_updated_seq" in {
            column["name"] for column in inspector.get_columns("sessions")
        }
    finally:
        engine.dispose()

    upgrade_database(db_url=url, revision="v2_22")

    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        assert not inspector.has_table("session_message_queue")
        assert "message_queue_updated_seq" not in {
            column["name"] for column in inspector.get_columns("sessions")
        }
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_22"
            )
    finally:
        engine.dispose()


def test_v2_23_adds_immutable_session_shares(tmp_path) -> None:
    path = tmp_path / "session-shares.sqlite3"
    url = _sqlite_url(path)
    upgrade_database(db_url=url, revision="v2_22")

    engine = create_engine(f"sqlite:///{path}")
    try:
        assert "session_shares" not in inspect(engine).get_table_names()
    finally:
        engine.dispose()

    upgrade_database(db_url=url, revision="v2_23")

    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        assert inspector.has_table("session_shares")
        assert {
            "id",
            "user_id",
            "session_id",
            "scope",
            "snapshot_json",
            "allowed_file_ids_json",
            "created_at",
        } == {column["name"] for column in inspector.get_columns("session_shares")}
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_23"
            )
    finally:
        engine.dispose()


def test_v2_24_adds_sequence_allocation_high_watermark(tmp_path) -> None:
    path = tmp_path / "session-sequence-high-watermark.sqlite3"
    url = _sqlite_url(path)
    upgrade_database(db_url=url, revision="v2_23")

    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO connectors "
                    "(id, user_id, name, status, token_hash, token_prefix, revoked, "
                    "created_at, updated_at) VALUES "
                    "('conn_seq', 'user_seq', 'Sequence', 'online', 'hash', "
                    "'cxt_', 0, :now, :now)"
                ),
                {"now": "2026-09-02T00:00:00Z"},
            )
            connection.execute(
                text(
                    "INSERT INTO sessions "
                    "(id, connector_id, runtime, runtime_id, origin, status, takeover, pinned, "
                    "archived, last_read_seq, latest_turn_end_seq, timeline_reset_seq, "
                    "seq, updated_seq, created_at, updated_at) VALUES "
                    "('sess_seq', 'conn_seq', 'codex', 'codex', 'connector_import', 'idle', "
                    "0, 0, 0, 2147483650, 2147483651, 2147483652, 2147483653, "
                    "2147483654, :now, :now)"
                ),
                {"now": "2026-09-02T00:00:00Z"},
            )
            connection.execute(
                text(
                    "INSERT INTO timeline_items "
                    "(session_id, id, type, status, order_seq, updated_seq, "
                    "payload_json) VALUES "
                    "('sess_seq', 'item_seq', 'message', 'completed', 1, "
                    "2147483655, '{}')"
                )
            )
    finally:
        engine.dispose()

    upgrade_database(db_url=url, revision="v2_24")

    engine = create_engine(f"sqlite:///{path}")
    try:
        columns = {
            column["name"]: column for column in inspect(engine).get_columns("sessions")
        }
        assert columns["seq_allocated_high"]["nullable"] is False
        with engine.connect() as connection:
            row = connection.execute(
                text(
                    "SELECT last_read_seq, latest_turn_end_seq, timeline_reset_seq, "
                    "seq, seq_allocated_high, updated_seq FROM sessions "
                    "WHERE id = 'sess_seq'"
                )
            ).one()
            assert tuple(row) == (
                2147483650,
                2147483651,
                2147483652,
                2147483655,
                2147483655,
                2147483655,
            )
            assert (
                connection.execute(
                    text(
                        "SELECT updated_seq FROM timeline_items "
                        "WHERE session_id = 'sess_seq' AND id = 'item_seq'"
                    )
                ).scalar_one()
                == 2147483655
            )
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_24"
            )
    finally:
        engine.dispose()

    with pytest.raises(RuntimeError, match="signed 32-bit range"):
        command.downgrade(_alembic_config(url), "v2_23")

    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE timeline_items SET updated_seq = 0 "
                    "WHERE session_id = 'sess_seq'"
                )
            )
            connection.execute(
                text(
                    "UPDATE sessions SET last_read_seq = 0, "
                    "latest_turn_end_seq = 0, timeline_reset_seq = 0, "
                    "seq = 0, updated_seq = 0, seq_allocated_high = 1 "
                    "WHERE id = 'sess_seq'"
                )
            )
    finally:
        engine.dispose()

    with pytest.raises(RuntimeError, match="allocated sequence ranges are ahead"):
        command.downgrade(_alembic_config(url), "v2_23")

    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE sessions SET seq_allocated_high = seq WHERE id = 'sess_seq'"
                )
            )
    finally:
        engine.dispose()

    command.downgrade(_alembic_config(url), "v2_23")
    engine = create_engine(f"sqlite:///{path}")
    try:
        assert "seq_allocated_high" not in {
            column["name"] for column in inspect(engine).get_columns("sessions")
        }
        assert inspect(engine).has_table("session_shares")
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_23"
            )
    finally:
        engine.dispose()


@pytest.mark.parametrize(
    "negative_target",
    ["last_read_seq", "timeline_items.updated_seq"],
)
def test_v2_24_rejects_negative_sequence_clocks(
    tmp_path,
    negative_target: str,
) -> None:
    path = tmp_path / f"session-negative-sequence-{negative_target.replace('.', '-')}.sqlite3"
    url = _sqlite_url(path)
    upgrade_database(db_url=url, revision="v2_23")

    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO connectors "
                    "(id, user_id, name, status, token_hash, token_prefix, revoked, "
                    "created_at, updated_at) VALUES "
                    "('conn_negative_seq', 'user_negative_seq', 'Sequence', "
                    "'online', 'hash', 'cxt_', 0, :now, :now)"
                ),
                {"now": "2026-09-02T00:00:00Z"},
            )
            connection.execute(
                text(
                    "INSERT INTO sessions "
                    "(id, connector_id, runtime, runtime_id, origin, status, takeover, "
                    "pinned, archived, last_read_seq, latest_turn_end_seq, "
                    "timeline_reset_seq, seq, updated_seq, created_at, updated_at) "
                    "VALUES ('sess_negative_seq', 'conn_negative_seq', 'codex', "
                    "'codex', 'connector_import', 'idle', 0, 0, 0, 10, 10, 10, "
                    "10, 10, :now, :now)"
                ),
                {"now": "2026-09-02T00:00:00Z"},
            )
            if negative_target == "last_read_seq":
                connection.execute(
                    text(
                        "UPDATE sessions SET last_read_seq = -1 "
                        "WHERE id = 'sess_negative_seq'"
                    )
                )
            else:
                connection.execute(
                    text(
                        "INSERT INTO timeline_items "
                        "(session_id, id, type, status, order_seq, updated_seq, "
                        "payload_json) VALUES "
                        "('sess_negative_seq', 'item_negative_seq', 'message', "
                        "'completed', 1, -1, '{}')"
                    )
                )
    finally:
        engine.dispose()

    with pytest.raises(RuntimeError, match="outside the protocol range"):
        upgrade_database(db_url=url, revision="v2_24")


def test_current_schema_drops_legacy_approval_notice_storage(tmp_path) -> None:
    path = tmp_path / "approval-v2-2.sqlite3"
    upgrade_database(db_url=_sqlite_url(path), revision="v2_2")
    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            notice_id = (
                "notice_approval_"
                + hashlib.sha256(
                    json.dumps(
                        ("appr_migrate",),
                        ensure_ascii=False,
                        sort_keys=True,
                        default=str,
                    ).encode("utf-8")
                ).hexdigest()[:24]
            )
            connection.execute(
                text(
                    "INSERT INTO connectors "
                    "(id, user_id, name, status, token_hash, token_prefix, revoked, created_at, updated_at) "
                    "VALUES ('conn_approval', 'user_approval', 'Approval', 'offline', 'hash', 'cxt_', 0, :now, :now)"
                ),
                {"now": "2026-07-30T00:00:00Z"},
            )
            connection.execute(
                text(
                    "INSERT INTO sessions "
                    "(id, connector_id, runtime, origin, status, takeover, pinned, archived, "
                    "last_read_seq, seq, updated_seq, created_at, updated_at) "
                    "VALUES ('sess_approval', 'conn_approval', 'codex', 'connector_import', "
                    "'blocked', 1, 0, 0, 0, 7, 7, :now, :now)"
                ),
                {"now": "2026-07-30T00:00:00Z"},
            )
            connection.execute(
                text(
                    "INSERT INTO approvals "
                    "(id, session_id, turn_id, status, kind, target_item_id, title, description, "
                    "payload_json, choices_json, source_json, updated_seq, created_at) "
                    "VALUES ('appr_migrate', 'sess_approval', 'turn_1', 'pending', 'command', "
                    "'tool_1', 'Run command', 'pwd', :payload, :choices, :source, 7, :now)"
                ),
                {
                    "payload": json.dumps({"command": "pwd"}),
                    "choices": json.dumps(["approve", "reject"]),
                    "source": json.dumps(
                        {
                            "runtime": "codex",
                            "requestId": 42,
                            "sessionId": "thread_1",
                            "turnId": "turn_1",
                        }
                    ),
                    "now": "2026-07-30T00:00:00Z",
                },
            )
            connection.execute(
                text(
                    "INSERT INTO notices "
                    "(id, session_id, type, status, interaction_type, blocking_json, "
                    "response_required, severity, title, message, source_json, actions_json, "
                    "context_json, metadata_json, revision, updated_seq, created_at, updated_at) "
                    "VALUES (:id, 'sess_approval', 'interaction', 'open', 'approval', :blocking, "
                    "1, 'warning', 'Run command', 'pwd', :notice_source, :actions, :context, '{}', "
                    "1, 7, :now, :now)"
                ),
                {
                    "id": notice_id,
                    "blocking": json.dumps(
                        {"scope": "session", "targetId": "sess_approval"}
                    ),
                    "notice_source": json.dumps(
                        {
                            "runtime": "codex",
                            "approvalId": "appr_migrate",
                            "timelineItemId": "tool_1",
                        }
                    ),
                    "actions": json.dumps(
                        [{"actionId": "approve", "label": "Approve"}]
                    ),
                    "context": json.dumps({"approvalId": "appr_migrate"}),
                    "now": "2026-07-30T00:00:00Z",
                },
            )
    finally:
        engine.dispose()

    upgrade_database(db_url=_sqlite_url(path))

    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        assert "approvals" not in inspector.get_table_names()
        assert "notices" not in inspector.get_table_names()
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


def test_postgres_pool_settings_are_configurable(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_SIZE", "7")
    monkeypatch.setenv("AGENT_SERVER_DB_MAX_OVERFLOW", "3")
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_TIMEOUT", "4.5")
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_RECYCLE", "600")

    backend, engine = build_engine(
        url="postgresql+asyncpg://agents:secret@127.0.0.1:5432/agents"
    )
    try:
        assert backend == "postgres"
        assert engine.pool.size() == 7
        assert engine.pool._max_overflow == 3
        assert engine.pool._timeout == 4.5
        assert engine.pool._recycle == 600
        assert engine.pool._pre_ping is True
    finally:
        asyncio.run(engine.dispose())


def test_invalid_postgres_pool_setting_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_SIZE", "0")

    with pytest.raises(ValueError, match="AGENT_SERVER_DB_POOL_SIZE"):
        build_engine(url="postgresql+asyncpg://agents:secret@127.0.0.1:5432/agents")


def test_invalid_migration_lock_timeout_is_rejected(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SERVER_MIGRATION_LOCK_TIMEOUT", "never")

    with pytest.raises(DatabaseMigrationError, match="must be a number"):
        upgrade_database(db_url=_sqlite_url(tmp_path / "invalid-lock.sqlite3"))


def test_v1_rehearsal_requires_postgres_target(tmp_path) -> None:
    source = tmp_path / "legacy.sqlite3"
    _create_legacy_v1_database(source)

    with pytest.raises(DatabaseMigrationError, match="must be a PostgreSQL"):
        rehearse_v1_import(
            source_sqlite=source,
            target_url=_sqlite_url(tmp_path / "target.sqlite3"),
        )


def _seed_v2_13_runtime_storage(path) -> None:
    upgrade_database(db_url=_sqlite_url(path), revision="v2_13")
    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO connectors "
                    "(id, user_id, name, status, token_hash, token_prefix, revoked, "
                    "created_at, updated_at) VALUES "
                    "('conn_runtime_storage', 'user_runtime_storage', 'Storage', "
                    "'offline', 'hash', 'cxt_', 0, :now, :now)"
                ),
                {"now": "2026-08-24T13:38:00Z"},
            )
            for runtime in (
                {
                    "runtime_id": "codex",
                    "runtime_type": "process",
                    "display_name": "Shared Runtime",
                    "discovery_json": '{"path":"/usr/local/bin/codex"}',
                    "metadata_json": "{}",
                    "schema_json": '{"type":"object"}',
                    "ui_json": "{}",
                    "config_json": '{"model":"gpt-5"}',
                    "active": 1,
                    "status": "running",
                    "error_json": None,
                },
                {
                    "runtime_id": "dsh",
                    "runtime_type": "local-service",
                    "display_name": "Shared Runtime",
                    "discovery_json": '{"endpoint":"/tmp/dsh.sock"}',
                    "metadata_json": (
                        '{"bridgeVersion":"0.1.0","storageMode":"local"}'
                    ),
                    "schema_json": '{"type":"object"}',
                    "ui_json": '{"endpoint":{"component":"path"}}',
                    "config_json": None,
                    "active": 0,
                    "status": "error",
                    "error_json": '{"code":"bridge_unavailable"}',
                },
            ):
                connection.execute(
                    text(
                        "INSERT INTO device_runtimes "
                        "(connector_id, runtime_id, runtime_type, display_name, present, "
                        "discovery_json, inventory_metadata_json, config_schema_json, "
                        "ui_schema_json, config_json, active, status, error_json, "
                        "last_discovered_at, updated_at) VALUES "
                        "('conn_runtime_storage', :runtime_id, :runtime_type, "
                        ":display_name, 1, :discovery_json, :metadata_json, "
                        ":schema_json, :ui_json, :config_json, :active, :status, "
                        ":error_json, :now, :now)"
                    ),
                    {**runtime, "now": "2026-08-24T13:38:00Z"},
                )
            connection.execute(
                text(
                    "INSERT INTO sessions "
                    "(id, connector_id, runtime, origin, external_session_id, title, cwd, "
                    "status, takeover, pinned, pinned_at, archived, archived_at, "
                    "dsh_archive_legacy, source_state, source_state_at, source_scan_token, "
                    "last_read_seq, timeline_reset_seq, last_synced_at, source_observed_at, "
                    "last_activity_at, seq, updated_seq, created_at, updated_at) VALUES "
                    "('sess_runtime_storage', 'conn_runtime_storage', 'dsh', "
                    "'connector_import', 'dsh_external', 'Preserved DSH', '/tmp/work', "
                    "'running', 0, 1, '2026-08-24T13:39:00Z', 1, "
                    "'2026-08-24T13:40:00Z', 1, 'missing', "
                    "'2026-08-24T13:41:00Z', 'scan-preserved', 7, 8, "
                    "'2026-08-24T13:42:00Z', '2026-08-24T13:43:00Z', "
                    "'2026-08-24T13:44:00Z', 11, 12, :now, :now)"
                ),
                {"now": "2026-08-24T13:38:00Z"},
            )
            connection.execute(
                text(
                    "INSERT INTO session_active_runs "
                    "(session_id, runtime, external_session_id, status, params_json, "
                    "started_at, updated_at) VALUES "
                    "('sess_runtime_storage', 'dsh', 'dsh_external', 'running', "
                    '\'{"model":"deepseek"}\', :now, :now)'
                ),
                {"now": "2026-08-24T13:38:00Z"},
            )
            connection.execute(
                text(
                    "INSERT INTO connector_runtime_catalogs "
                    "(connector_id, runtime, catalog_type, revision, catalog_json, "
                    "updated_at) VALUES "
                    "('conn_runtime_storage', 'dsh', 'model', 17, "
                    '\'{"models":["deepseek"]}\', :now)'
                ),
                {"now": "2026-08-24T13:38:00Z"},
            )
    finally:
        engine.dispose()


def _create_legacy_v1_database(path) -> None:
    engine = create_engine(f"sqlite:///{path}")
    metadata.create_all(engine)
    with engine.begin() as connection:
        # Current metadata contains tables and columns introduced after v1.
        # Remove them before constructing the historical legacy fixture so
        # their real Alembic revisions can create them during the upgrade.
        connection.execute(text("DROP TABLE session_shares"))
        connection.execute(text("ALTER TABLE sessions DROP COLUMN seq_allocated_high"))
        connection.execute(
            text(
                "CREATE TABLE approvals ("
                "id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT, status TEXT NOT NULL, "
                "kind TEXT NOT NULL, target_item_id TEXT, title TEXT NOT NULL, description TEXT, "
                "payload_json TEXT NOT NULL, choices_json TEXT NOT NULL, source_json TEXT NOT NULL, "
                "updated_seq INTEGER NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT)"
            )
        )
        connection.execute(text("DROP TABLE IF EXISTS notices"))
        connection.execute(text("DROP TABLE connector_protocol_capabilities"))
        connection.execute(text("DROP TABLE connector_runtime_catalogs"))
        connection.execute(text("DROP TABLE device_runtimes"))
        connection.execute(text("DROP TABLE connector_runtime_types"))
        connection.execute(text("DROP TABLE IF EXISTS session_states"))
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
        connection.execute(text("ALTER TABLE sessions DROP COLUMN runtime_id"))
        connection.execute(
            text("ALTER TABLE session_active_runs DROP COLUMN runtime_id")
        )
        connection.execute(
            text("ALTER TABLE connectors DROP COLUMN presence_instance_id")
        )
        connection.execute(
            text("ALTER TABLE connectors DROP COLUMN presence_connection_id")
        )
        connection.execute(
            text("ALTER TABLE connectors DROP COLUMN runtime_control_version")
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
            text("CREATE TABLE agent_modes (id TEXT PRIMARY KEY, label TEXT NOT NULL)")
        )
        connection.execute(
            text("INSERT INTO agent_modes (id, label) VALUES ('mode_legacy', 'Legacy')")
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
