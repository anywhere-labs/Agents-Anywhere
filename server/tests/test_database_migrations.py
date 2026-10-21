from __future__ import annotations

import asyncio
import hashlib
import json

import pytest
from agent_server.infra.db.engine import build_engine, resolve_db_url
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
from alembic import command
from migrations.versions import v2_24
from sqlalchemy import BigInteger, create_engine, inspect, text
from sqlalchemy.dialects.postgresql import asyncpg as postgresql_asyncpg
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool


def _sync_url(url: str) -> str:
    """The asyncpg test URL as a synchronous psycopg URL for inspection."""
    return url.replace("postgresql+asyncpg://", "postgresql+psycopg://", 1)


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


def test_v2_24_protocol_limit_uses_postgresql_bigint_bind() -> None:
    statement = v2_24._sequence_range_statement("sessions", "last_read_seq")

    compiled = str(statement.compile(dialect=postgresql_asyncpg.dialect()))

    assert "$1::BIGINT" in compiled


def test_runtime_database_url_is_required(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_SERVER_DB_URL", raising=False)

    with pytest.raises(ValueError, match="AGENT_SERVER_DB_URL is required"):
        resolve_db_url()


def test_non_postgresql_database_url_is_rejected() -> None:
    with pytest.raises(ValueError, match="unsupported AGENT_SERVER_DB_URL scheme"):
        resolve_db_url("mysql+aiomysql://agents:secret@127.0.0.1:3306/agents")


def test_empty_database_upgrades_to_current_schema(fresh_database_url) -> None:
    url = fresh_database_url

    upgrade_database(db_url=url)

    engine = create_engine(_sync_url(url))
    try:
        tables = set(inspect(engine).get_table_names())
        assert {
            "alembic_version",
            "_deprecated_app_releases",
            "device_runtimes",
            "session_shares",
            "sessions",
        }.issubset(tables)
        assert "approvals" not in tables
        assert "notices" not in tables
        assert "app_releases" not in tables
    finally:
        engine.dispose()
    async_engine = create_async_engine(url, poolclass=NullPool)
    try:
        assert asyncio.run(database_revision(async_engine)) == CURRENT_SCHEMA_REVISION
        asyncio.run(require_current_database(async_engine))
    finally:
        asyncio.run(async_engine.dispose())


def test_unversioned_v2_database_is_stamped_without_rebuilding(fresh_database_url) -> None:
    url = fresh_database_url
    engine = create_engine(_sync_url(url))
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

    upgrade_database(db_url=url)

    engine = create_engine(_sync_url(url))
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


def test_unversioned_v2_2_database_is_stamped_then_upgraded(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_2")
    engine = create_engine(_sync_url(url))
    try:
        with engine.begin() as connection:
            connection.execute(text("DROP TABLE alembic_version"))
    finally:
        engine.dispose()

    upgrade_database(db_url=url)

    engine = create_engine(_sync_url(url))
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
def test_unversioned_recent_v2_database_runs_remaining_migrations(tmp_path,
    source_revision: str,
    fresh_database_url,
) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision=source_revision)
    engine = create_engine(_sync_url(url))
    try:
        with engine.begin() as connection:
            connection.execute(text("DROP TABLE alembic_version"))
    finally:
        engine.dispose()

    upgrade_database(db_url=url)

    engine = create_engine(_sync_url(url))
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


def test_v2_0_database_upgrades_through_current_revision(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_0")

    engine = create_engine(_sync_url(url))
    try:
        columns = {
            column["name"] for column in inspect(engine).get_columns("connectors")
        }
        assert "presence_connection_id" not in columns
    finally:
        engine.dispose()

    upgrade_database(db_url=url)

    engine = create_engine(_sync_url(url))
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
        ("v2_24", "v2_25"),
        ("v2_25", "v2_26"),
        ("v2_26", "v2_27"),
        ("v2_27", "v2_28"),
        ("v2_28", "v2_29"),
        ("v2_29", "v2_30"),
        ("v2_30", "v2_31"),
        ("v2_31", "v2_32"),
        ("v2_32", "v2_33"),
    ],
)
def test_every_adjacent_schema_upgrade(tmp_path,
    source_revision: str,
    target_revision: str,
    fresh_database_url,
) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision=source_revision)

    upgrade_database(db_url=url, revision=target_revision)

    engine = create_engine(_sync_url(url))
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


@pytest.mark.parametrize("previous_control_version", ["1.0", "2.0"])
def test_v2_33_removes_negotiation_state_and_preserves_runtime_data(tmp_path,
    previous_control_version: str,
    fresh_database_url,
) -> None:
    url = fresh_database_url
    _seed_v2_13_runtime_storage(url)
    upgrade_database(db_url=url, revision="v2_32")
    engine = create_engine(_sync_url(url))
    tables = (
        "connectors",
        "connector_runtime_types",
        "device_runtimes",
        "sessions",
        "session_active_runs",
        "connector_runtime_catalogs",
    )

    def snapshot():
        with engine.connect() as connection:
            result = {}
            for table in tables:
                rows = [
                    dict(row)
                    for row in connection.execute(
                        text(f"SELECT * FROM {table}")
                    ).mappings()
                ]
                for row in rows:
                    row.pop("runtime_control_version", None)
                result[table] = sorted(
                    rows, key=lambda row: json.dumps(row, sort_keys=True)
                )
            return result

    try:
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE connectors SET runtime_control_version = :version"),
                {"version": previous_control_version},
            )
        before = snapshot()
        assert before["device_runtimes"] and before["sessions"]
        upgrade_database(db_url=url, revision="v2_33")
        assert "runtime_control_version" not in {
            column["name"] for column in inspect(engine).get_columns("connectors")
        }
        assert snapshot() == before
    finally:
        engine.dispose()


def test_v2_8_removes_turn_id_from_active_session_runs(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_7")

    engine = create_engine(_sync_url(url))
    try:
        assert "turn_id" in {
            column["name"]
            for column in inspect(engine).get_columns("session_active_runs")
        }
    finally:
        engine.dispose()


def test_v2_9_removes_turn_data_from_timelines(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_8")

    engine = create_engine(_sync_url(url))
    try:
        with engine.begin() as connection:
            # Historical rows without their parents; disable FK enforcement for this transaction.
            connection.execute(text("SET LOCAL session_replication_role = 'replica'"))
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

    upgrade_database(db_url=url, revision="v2_9")

    engine = create_engine(_sync_url(url))
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

    upgrade_database(db_url=url, revision="v2_8")

    engine = create_engine(_sync_url(url))
    try:
        assert "turn_id" not in {
            column["name"]
            for column in inspect(engine).get_columns("session_active_runs")
        }
    finally:
        engine.dispose()


def test_v2_10_adds_timeline_reset_watermark(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_9")

    engine = create_engine(_sync_url(url))
    try:
        assert "timeline_reset_seq" not in {
            column["name"] for column in inspect(engine).get_columns("sessions")
        }
    finally:
        engine.dispose()

    upgrade_database(db_url=url, revision="v2_10")

    engine = create_engine(_sync_url(url))
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


def test_v2_11_adds_dsh_facts_and_runtime_metadata(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_10")

    upgrade_database(db_url=url, revision="v2_11")

    engine = create_engine(_sync_url(url))
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


def test_v2_12_adds_dsh_source_state_without_rewriting_archives(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_11")
    engine = create_engine(_sync_url(url))
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

    upgrade_database(db_url=url, revision="v2_12")

    engine = create_engine(_sync_url(url))
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


def test_v2_13_marks_only_existing_dsh_archives_as_legacy(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_12")
    engine = create_engine(_sync_url(url))
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

    upgrade_database(db_url=url, revision="v2_13")

    engine = create_engine(_sync_url(url))
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


def test_v2_14_splits_runtime_storage_without_losing_dsh_state(fresh_database_url) -> None:
    url = fresh_database_url
    _seed_v2_13_runtime_storage(url)

    upgrade_database(db_url=url, revision="v2_14")

    engine = create_engine(_sync_url(url))
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
        for table_name in ("sessions", "session_active_runs"):
            runtime_id = next(
                column for column in inspector.get_columns(table_name)
                if column["name"] == "runtime_id"
            )
            assert runtime_id["nullable"] is False
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


def test_v2_14_compatible_data_downgrades_to_v2_13(fresh_database_url) -> None:
    url = fresh_database_url
    _seed_v2_13_runtime_storage(url)
    upgrade_database(db_url=url, revision="v2_14")

    command.downgrade(_alembic_config(url), "v2_13")

    engine = create_engine(_sync_url(url))
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
def test_v2_14_downgrade_rejects_instance_specific_data(tmp_path,
    incompatible_sql: str,
    fresh_database_url,
) -> None:
    url = fresh_database_url
    _seed_v2_13_runtime_storage(url)
    upgrade_database(db_url=url, revision="v2_14")
    engine = create_engine(_sync_url(url))
    try:
        with engine.begin() as connection:
            connection.execute(text(incompatible_sql))
    finally:
        engine.dispose()

    with pytest.raises(RuntimeError, match="cannot downgrade v2_14"):
        command.downgrade(_alembic_config(url), "v2_13")

    engine = create_engine(_sync_url(url))
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
        "v2_25",
        "v2_26",
        "v2_27",
        "v2_28",
        "v2_29",
        "v2_30",
        "v2_31",
    ],
)
def test_unversioned_runtime_schema_is_classified_by_actual_columns(tmp_path,
    revision: str,
    fresh_database_url,
) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision=revision)
    engine = create_engine(_sync_url(url))
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


def test_current_schema_version_is_v2_44() -> None:
    assert CURRENT_SCHEMA_REVISION == "v2_44"
    assert CURRENT_SCHEMA_VERSION == "2.44"


def _insert_required(connection, table: str, values: dict) -> None:
    """Insert a row, filling other NOT NULL columns without defaults."""
    row = {
        column["name"]: 0 if "INT" in str(column["type"]).upper() else "x"
        for column in inspect(connection).get_columns(table)
        if not column["nullable"] and column["default"] is None
    }
    row.update(values)
    names = ", ".join(row)
    params = ", ".join(f":{name}" for name in row)
    connection.execute(text(f"INSERT INTO {table} ({names}) VALUES ({params})"), row)


def test_v2_44_drops_unconfigured_runtime_placeholders(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_43")
    engine = create_engine(_sync_url(url))
    try:
        with engine.begin() as connection:
            # Placeholder rows only need the columns the migration looks at.
            connection.execute(text("SET LOCAL session_replication_role = 'replica'"))
            _insert_required(connection, "connectors", {"id": "conn", "revoked": 0})
            _insert_required(connection, "connector_runtime_types", {
                "connector_id": "conn", "runtime_type": "codex",
            })
            for runtime_id, config in (
                ("rti_placeholder", None),
                ("rti_configured", "{}"),
                ("rti_with_session", None),
            ):
                _insert_required(connection, "device_runtimes", {
                    "connector_id": "conn",
                    "runtime_id": runtime_id,
                    "runtime_type": "codex",
                    "name": runtime_id,
                    "name_key": runtime_id,
                    "config_json": config,
                    "error_json": None,
                })
            _insert_required(connection, "sessions", {
                "id": "sess", "connector_id": "conn", "runtime": "codex",
                "runtime_id": "rti_with_session",
            })
    finally:
        engine.dispose()

    upgrade_database(db_url=url)

    engine = create_engine(_sync_url(url))
    try:
        with engine.connect() as connection:
            remaining = set(connection.execute(
                text("SELECT runtime_id FROM device_runtimes")
            ).scalars())
        assert remaining == {"rti_configured", "rti_with_session"}
    finally:
        engine.dispose()



def test_v2_43_adds_the_runtime_phase_column(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_42")
    engine = create_engine(_sync_url(url))
    try:
        columns = {column["name"] for column in inspect(engine).get_columns("device_runtimes")}
        assert "phase_json" not in columns
    finally:
        engine.dispose()

    upgrade_database(db_url=url)
    upgrade_database(db_url=url)

    engine = create_engine(_sync_url(url))
    try:
        columns = {column["name"] for column in inspect(engine).get_columns("device_runtimes")}
        assert "phase_json" in columns
    finally:
        engine.dispose()


def test_v2_42_replaces_dashboard_tables_with_usage_events(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_41")
    engine = create_engine(_sync_url(url))
    try:
        inspector = inspect(engine)
        assert inspector.has_table("dashboard_daily_metrics")
        assert inspector.has_table("platform_user_activity")
        assert not inspector.has_table("usage_events")
    finally:
        engine.dispose()

    upgrade_database(db_url=url)
    upgrade_database(db_url=url)

    engine = create_engine(_sync_url(url))
    try:
        inspector = inspect(engine)
        for table in (
            "dashboard_daily_metrics",
            "dashboard_user_daily_facts",
            "dashboard_settings",
            "platform_user_activity",
        ):
            assert not inspector.has_table(table)
        event_columns = {column["name"] for column in inspector.get_columns("usage_events")}
        assert {"hour_bucket", "event_type", "dedupe_key", "duration_ms"}.issubset(event_columns)
        index_names = {index["name"] for index in inspector.get_indexes("usage_events")}
        assert "idx_usage_events_type_hour" in index_names
        assert inspector.has_table("usage_inventory_snapshots")
    finally:
        engine.dispose()

    command.downgrade(_alembic_config(url), "v2_41")

    engine = create_engine(_sync_url(url))
    try:
        inspector = inspect(engine)
        assert inspector.has_table("dashboard_daily_metrics")
        assert not inspector.has_table("usage_events")
    finally:
        engine.dispose()


def test_v2_41_drops_the_sidebar_order_table(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_40")
    engine = create_engine(_sync_url(url))
    try:
        assert inspect(engine).has_table("user_sidebar_orders")
    finally:
        engine.dispose()

    upgrade_database(db_url=url)
    upgrade_database(db_url=url)

    engine = create_engine(_sync_url(url))
    try:
        assert not inspect(engine).has_table("user_sidebar_orders")
    finally:
        engine.dispose()


def test_v2_40_removes_auto_archive_and_restores_swept_sessions(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_39")
    engine = create_engine(_sync_url(url))
    try:
        with engine.begin() as connection:
            # Placeholder rows only need the columns the migration touches.
            connection.execute(text("SET LOCAL session_replication_role = 'replica'"))
            required = [
                (column["name"], str(column["type"]))
                for column in inspect(connection).get_columns("sessions")
                if not column["nullable"]
                and column["default"] is None
                and column["name"] not in {"id", "archived", "auto_archived"}
            ]
            for session_id, auto_archived in (("swept", 1), ("by-user", 0)):
                values = {
                    name: 0 if "INT" in kind.upper() else "x" for name, kind in required
                }
                values.update(
                    id=session_id,
                    archived=1,
                    archived_at="2026-01-01T00:00:00Z",
                    auto_archived=auto_archived,
                )
                names = ", ".join(values)
                params = ", ".join(f":{name}" for name in values)
                connection.execute(
                    text(f"INSERT INTO sessions ({names}) VALUES ({params})"), values
                )
    finally:
        engine.dispose()

    upgrade_database(db_url=url, revision="v2_40")
    upgrade_database(db_url=url)

    engine = create_engine(_sync_url(url))
    try:
        inspector = inspect(engine)
        columns = {column["name"] for column in inspector.get_columns("sessions")}
        indexes = {index["name"] for index in inspector.get_indexes("sessions")}
        with engine.connect() as connection:
            archived = dict(
                connection.execute(text("SELECT id, archived FROM sessions")).all()
            )
    finally:
        engine.dispose()

    assert not {"auto_archived", "auto_archived_at"} & columns
    assert "idx_sessions_auto_archive" not in indexes
    assert archived == {"swept": 0, "by-user": 1}


def test_v2_37_adds_session_title_source(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_36")
    engine = create_engine(_sync_url(url))
    try:
        before = {column["name"] for column in inspect(engine).get_columns("sessions")}
        assert "title_source" not in before
        upgrade_database(db_url=url)
        upgrade_database(db_url=url)
        after = {column["name"] for column in inspect(engine).get_columns("sessions")}
    finally:
        engine.dispose()

    assert "title_source" in after


def test_v2_36_adds_retired_runtime_identity_storage(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_35")
    engine = create_engine(_sync_url(url))
    try:
        assert "retired_device_runtimes" not in inspect(engine).get_table_names()
        upgrade_database(db_url=url)
        upgrade_database(db_url=url)
        schema = inspect(engine)
        assert schema.get_pk_constraint("retired_device_runtimes")["constrained_columns"] == ["connector_id", "runtime_id"]
        foreign_key = schema.get_foreign_keys("retired_device_runtimes")[0]
        assert foreign_key["referred_table"] == "connectors"
        assert foreign_key["options"]["ondelete"] == "CASCADE"
    finally:
        engine.dispose()


def test_retiring_releases_preserves_history(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_31")
    engine = create_engine(_sync_url(url))
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO app_releases (platform, version_code, version_name, "
                    "download_url, published, created_at, updated_at) "
                    "VALUES ('desktop', 1, '0.1.0', 'https://example.test/desktop', "
                    "1, '2026-01-01', '2026-01-01')"
                )
            )
            original_rows = connection.execute(
                text("SELECT * FROM app_releases ORDER BY platform, version_code")
            ).all()
        upgrade_database(db_url=url)
        assert not inspect(engine).has_table("app_releases")
        with engine.connect() as connection:
            assert connection.execute(
                text(
                    "SELECT * FROM _deprecated_app_releases "
                    "ORDER BY platform, version_code"
                )
            ).all() == original_rows
    finally:
        engine.dispose()


def test_v2_20_adds_session_source_observation_details(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_19")
    upgrade_database(db_url=url, revision="v2_20")

    engine = create_engine(_sync_url(url))
    try:
        columns = {column["name"] for column in inspect(engine).get_columns("sessions")}
    finally:
        engine.dispose()

    assert {"source_state_reason", "source_observation_origin"}.issubset(columns)


def test_v2_22_retires_session_message_queue_schema(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_21")

    engine = create_engine(_sync_url(url))
    try:
        inspector = inspect(engine)
        assert inspector.has_table("session_message_queue")
        assert "message_queue_updated_seq" in {
            column["name"] for column in inspector.get_columns("sessions")
        }
    finally:
        engine.dispose()

    upgrade_database(db_url=url, revision="v2_22")

    engine = create_engine(_sync_url(url))
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


def test_v2_23_adds_immutable_session_shares(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_22")

    engine = create_engine(_sync_url(url))
    try:
        assert "session_shares" not in inspect(engine).get_table_names()
    finally:
        engine.dispose()

    upgrade_database(db_url=url, revision="v2_23")

    engine = create_engine(_sync_url(url))
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


def test_v2_24_adds_sequence_allocation_high_watermark(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_23")

    engine = create_engine(_sync_url(url))
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
                    "0, 0, 0, 50, 51, 52, 53, 54, :now, :now)"
                ),
                {"now": "2026-09-02T00:00:00Z"},
            )
            connection.execute(
                text(
                    "INSERT INTO timeline_items "
                    "(session_id, id, type, status, order_seq, updated_seq, "
                    "payload_json) VALUES "
                    "('sess_seq', 'item_seq', 'message', 'completed', 1, 55, '{}')"
                )
            )
    finally:
        engine.dispose()

    upgrade_database(db_url=url, revision="v2_24")

    engine = create_engine(_sync_url(url))
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
            assert tuple(row) == (50, 51, 52, 55, 55, 55)
            assert (
                connection.execute(
                    text(
                        "SELECT updated_seq FROM timeline_items "
                        "WHERE session_id = 'sess_seq' AND id = 'item_seq'"
                    )
                ).scalar_one()
                == 55
            )
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_24"
            )
    finally:
        engine.dispose()

    # The widened columns accept clocks beyond the signed 32-bit range, which
    # a downgrade must refuse to truncate.
    engine = create_engine(_sync_url(url))
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE sessions SET seq = 2147483655, seq_allocated_high = 2147483655, "
                    "updated_seq = 2147483655 WHERE id = 'sess_seq'"
                )
            )
            connection.execute(
                text(
                    "UPDATE timeline_items SET updated_seq = 2147483655 "
                    "WHERE session_id = 'sess_seq'"
                )
            )
    finally:
        engine.dispose()

    with pytest.raises(RuntimeError, match="signed 32-bit range"):
        command.downgrade(_alembic_config(url), "v2_23")

    engine = create_engine(_sync_url(url))
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

    engine = create_engine(_sync_url(url))
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
    engine = create_engine(_sync_url(url))
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
def test_v2_24_rejects_negative_sequence_clocks(tmp_path,
    negative_target: str,
    fresh_database_url,
) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_23")

    engine = create_engine(_sync_url(url))
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


def test_v2_26_adds_connector_kind_and_backfills_cli(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_23")

    engine = create_engine(_sync_url(url))
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO connectors "
                    "(id, user_id, name, status, token_hash, token_prefix, revoked, "
                    "created_at, updated_at) "
                    "VALUES ('conn_existing', 'user_existing', 'Existing CLI', "
                    "'offline', 'hash', 'prefix', 0, :now, :now)"
                ),
                {"now": "2026-09-02T00:00:00Z"},
            )
        assert "connector_kind" not in {
            column["name"] for column in inspect(engine).get_columns("connectors")
        }
    finally:
        engine.dispose()

    upgrade_database(db_url=url, revision="v2_26")

    engine = create_engine(_sync_url(url))
    try:
        columns = {
            column["name"]: column
            for column in inspect(engine).get_columns("connectors")
        }
        assert columns["connector_kind"]["nullable"] is False
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text(
                        "SELECT connector_kind FROM connectors "
                        "WHERE id = 'conn_existing'"
                    )
                ).scalar_one()
                == "cli"
            )
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_26"
            )
    finally:
        engine.dispose()


def test_v2_27_adds_projects_and_session_binding(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_26")

    upgrade_database(db_url=url, revision="v2_27")

    engine = create_engine(_sync_url(url))
    try:
        inspector = inspect(engine)
        assert "projects" in inspector.get_table_names()
        project_columns = {
            column["name"] for column in inspector.get_columns("projects")
        }
        assert {
            "id",
            "user_id",
            "connector_id",
            "name",
            "workspace_path",
            "workspace_key",
            "pinned",
            "pinned_at",
            "created_at",
            "updated_at",
        }.issubset(project_columns)
        session_columns = {
            column["name"] for column in inspector.get_columns("sessions")
        }
        assert "project_id" in session_columns
        project_indexes = {index["name"] for index in inspector.get_indexes("projects")}
        assert {
            "idx_projects_user_pinned_updated",
            "idx_projects_connector_workspace",
        }.issubset(project_indexes)
        assert "uq_projects_user_connector_workspace" in {
            constraint["name"]
            for constraint in inspector.get_unique_constraints("projects")
        }
        session_indexes = {index["name"] for index in inspector.get_indexes("sessions")}
        assert "idx_sessions_project_archived_sort" in session_indexes
        project_foreign_keys = inspector.get_foreign_keys("projects")
        assert any(
            foreign_key["referred_table"] == "users"
            for foreign_key in project_foreign_keys
        )
        assert any(
            foreign_key["referred_table"] == "connectors"
            for foreign_key in project_foreign_keys
        )
        session_foreign_keys = inspector.get_foreign_keys("sessions")
        project_fk = next(
            foreign_key
            for foreign_key in session_foreign_keys
            if foreign_key["referred_table"] == "projects"
        )
        assert project_fk["options"].get("ondelete") == "SET NULL"
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_27"
            )
    finally:
        engine.dispose()


def test_v2_28_allows_projects_to_share_a_workspace(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_27")

    upgrade_database(db_url=url, revision="v2_28")

    engine = create_engine(_sync_url(url))
    try:
        inspector = inspect(engine)
        assert "uq_projects_user_connector_workspace" not in {
            constraint["name"]
            for constraint in inspector.get_unique_constraints("projects")
        }
        assert "idx_projects_connector_workspace" in {
            index["name"] for index in inspector.get_indexes("projects")
        }
        now = "2026-09-03T00:00:00Z"
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users "
                    "(id, password_hash, role, disabled, created_at, updated_at) "
                    "VALUES ('user_shared_workspace', 'hash', 'member', 0, :now, :now)"
                ),
                {"now": now},
            )
            connection.execute(
                text(
                    "INSERT INTO connectors "
                    "(id, user_id, name, connector_kind, status, token_hash, "
                    "token_prefix, revoked, created_at, updated_at) "
                    "VALUES ('conn_shared_workspace', 'user_shared_workspace', "
                    "'Device', 'desktop', 'online', 'hash', 'prefix', 0, :now, :now)"
                ),
                {"now": now},
            )
            connection.execute(
                text(
                    "INSERT INTO projects "
                    "(id, user_id, connector_id, name, workspace_path, workspace_key, "
                    "pinned, created_at, updated_at) "
                    "VALUES (:id, 'user_shared_workspace', 'conn_shared_workspace', "
                    ":name, '/repo', '/repo', 0, :now, :now)"
                ),
                [
                    {"id": "proj_shared_a", "name": "Project A", "now": now},
                    {"id": "proj_shared_b", "name": "Project B", "now": now},
                ],
            )
            count = connection.execute(
                text(
                    "SELECT COUNT(*) FROM projects "
                    "WHERE connector_id = 'conn_shared_workspace' "
                    "AND workspace_key = '/repo'"
                )
            ).scalar_one()
            revision = connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
        assert count == 2
        assert revision == "v2_28"
    finally:
        engine.dispose()


def test_v2_29_backfills_projects_and_restricts_project_deletion(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_28")

    engine = create_engine(_sync_url(url))
    try:
        now = "2026-09-03T00:00:00Z"
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users "
                    "(id, password_hash, role, disabled, created_at, updated_at) "
                    "VALUES ('user_project_backfill', 'hash', 'member', 0, :now, :now)"
                ),
                {"now": now},
            )
            connection.execute(
                text(
                    "INSERT INTO connectors "
                    "(id, user_id, name, connector_kind, status, token_hash, "
                    "token_prefix, revoked, created_at, updated_at) "
                    "VALUES ('conn_project_backfill', 'user_project_backfill', "
                    "'Device', 'desktop', 'online', 'hash', 'prefix', 0, :now, :now)"
                ),
                {"now": now},
            )
            connection.execute(
                text(
                    "INSERT INTO projects "
                    "(id, user_id, connector_id, name, workspace_path, workspace_key, "
                    "pinned, created_at, updated_at) VALUES "
                    "('proj_existing', 'user_project_backfill', "
                    "'conn_project_backfill', 'Existing', '/repo', '/repo', "
                    "0, :now, :now)"
                ),
                {"now": now},
            )
            connection.execute(
                text(
                    "INSERT INTO sessions "
                    "(id, connector_id, runtime, runtime_id, origin, status, takeover, "
                    "pinned, archived, cwd, last_read_seq, latest_turn_end_seq, "
                    "timeline_reset_seq, seq, updated_seq, created_at, updated_at) "
                    "VALUES (:id, 'conn_project_backfill', 'codex', 'codex', "
                    "'connector_import', 'idle', 0, 0, 0, :cwd, 0, 0, 0, 0, 0, "
                    ":now, :now)"
                ),
                [
                    {"id": "sess_valid_workspace", "cwd": "/repo", "now": now},
                    {
                        "id": "sess_invalid_workspace",
                        "cwd": "relative/path",
                        "now": now,
                    },
                ],
            )
            connection.execute(
                text(
                    "INSERT INTO timeline_items "
                    "(session_id, id, type, status, order_seq, updated_seq, payload_json) "
                    "VALUES ('sess_invalid_workspace', 'item_invalid_workspace', "
                    "'message', 'completed', 1, 0, '{}')"
                )
            )
    finally:
        engine.dispose()

    upgrade_database(db_url=url, revision="v2_29")

    engine = create_engine(_sync_url(url))
    try:
        inspector = inspect(engine)
        project_fk = next(
            foreign_key
            for foreign_key in inspector.get_foreign_keys("sessions")
            if foreign_key["referred_table"] == "projects"
        )
        assert project_fk["options"].get("ondelete") == "RESTRICT"
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text(
                        "SELECT project_id FROM sessions "
                        "WHERE id = 'sess_valid_workspace'"
                    )
                ).scalar_one()
                == "proj_existing"
            )
            assert (
                connection.execute(
                    text(
                        "SELECT COUNT(*) FROM sessions "
                        "WHERE id = 'sess_invalid_workspace'"
                    )
                ).scalar_one()
                == 0
            )
            assert (
                connection.execute(
                    text(
                        "SELECT COUNT(*) FROM timeline_items "
                        "WHERE session_id = 'sess_invalid_workspace'"
                    )
                ).scalar_one()
                == 0
            )
            assert (
                connection.execute(
                    text(
                        "SELECT COUNT(*) FROM projects "
                        "WHERE connector_id = 'conn_project_backfill' "
                        "AND workspace_key = '/repo'"
                    )
                ).scalar_one()
                == 1
            )
            assert (
                connection.execute(
                    text("SELECT version_num FROM alembic_version")
                ).scalar_one()
                == "v2_29"
            )
    finally:
        engine.dispose()


def test_v2_30_consolidates_workspaces_and_deduplicates_names(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_29")

    engine = create_engine(_sync_url(url))
    try:
        now = "2026-09-03T00:00:00Z"
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users "
                    "(id, password_hash, role, disabled, created_at, updated_at) "
                    "VALUES ('user_unique_projects', 'hash', 'member', 0, :now, :now)"
                ),
                {"now": now},
            )
            connection.execute(
                text(
                    "INSERT INTO connectors "
                    "(id, user_id, name, connector_kind, status, token_hash, "
                    "token_prefix, revoked, created_at, updated_at) "
                    "VALUES ('conn_unique_projects', 'user_unique_projects', "
                    "'Device', 'desktop', 'online', 'hash', 'prefix', 0, :now, :now)"
                ),
                {"now": now},
            )
            connection.execute(
                text(
                    "INSERT INTO projects "
                    "(id, user_id, connector_id, name, workspace_path, workspace_key, "
                    "pinned, created_at, updated_at) VALUES "
                    "(:id, 'user_unique_projects', 'conn_unique_projects', :name, "
                    ":path, :path, 0, :created_at, :updated_at)"
                ),
                [
                    {
                        "id": "proj_workspace_keeper",
                        "name": "Shared",
                        "path": "/repo",
                        "created_at": now,
                        "updated_at": now,
                    },
                    {
                        "id": "proj_workspace_duplicate",
                        "name": "Second",
                        "path": "/repo",
                        "created_at": "2026-09-03T00:00:01Z",
                        "updated_at": "2026-09-03T00:00:01Z",
                    },
                    {
                        "id": "proj_name_duplicate",
                        "name": "Shared",
                        "path": "/other",
                        "created_at": "2026-09-03T00:00:02Z",
                        "updated_at": "2026-09-03T00:00:02Z",
                    },
                ],
            )
            connection.execute(
                text(
                    "INSERT INTO sessions "
                    "(id, connector_id, project_id, runtime, runtime_id, origin, "
                    "status, takeover, pinned, archived, cwd, last_read_seq, "
                    "latest_turn_end_seq, timeline_reset_seq, seq, updated_seq, "
                    "created_at, updated_at) VALUES "
                    "('sess_duplicate_project', 'conn_unique_projects', "
                    "'proj_workspace_duplicate', 'codex', 'codex', "
                    "'connector_import', 'idle', 0, 0, 0, '/repo', 0, 0, 0, "
                    "0, 0, :now, :now)"
                ),
                {"now": now},
            )
    finally:
        engine.dispose()

    upgrade_database(db_url=url, revision="v2_30")

    engine = create_engine(_sync_url(url))
    try:
        inspector = inspect(engine)
        assert {
            "uq_projects_user_connector_workspace",
            "uq_projects_user_name",
        }.issubset(
            {
                constraint["name"]
                for constraint in inspector.get_unique_constraints("projects")
            }
        )
        with engine.connect() as connection:
            projects = (
                connection.execute(
                    text(
                        "SELECT id, name, workspace_key FROM projects "
                        "WHERE user_id = 'user_unique_projects' ORDER BY id"
                    )
                )
                .mappings()
                .all()
            )
            revision = connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one()
            session_project_id = connection.execute(
                text(
                    "SELECT project_id FROM sessions "
                    "WHERE id = 'sess_duplicate_project'"
                )
            ).scalar_one()
        assert [dict(project) for project in projects] == [
            {
                "id": "proj_name_duplicate",
                "name": "Shared (1)",
                "workspace_key": "/other",
            },
            {
                "id": "proj_workspace_keeper",
                "name": "Shared",
                "workspace_key": "/repo",
            },
        ]
        assert session_project_id == "proj_workspace_keeper"
        assert revision == "v2_30"
    finally:
        engine.dispose()


def test_current_schema_drops_legacy_approval_notice_storage(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_2")
    engine = create_engine(_sync_url(url))
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

    upgrade_database(db_url=url)

    engine = create_engine(_sync_url(url))
    try:
        inspector = inspect(engine)
        assert "approvals" not in inspector.get_table_names()
        assert "notices" not in inspector.get_table_names()
    finally:
        engine.dispose()


def test_unknown_unversioned_database_is_rejected(fresh_database_url) -> None:
    url = fresh_database_url
    engine = create_engine(_sync_url(url))
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE unrelated (id TEXT PRIMARY KEY)"))
    finally:
        engine.dispose()

    with pytest.raises(DatabaseMigrationError, match="does not match"):
        upgrade_database(db_url=url)


def test_postgres_pool_settings_are_configurable(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_SERVER_DB_NULL_POOL", raising=False)
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_SIZE", "7")
    monkeypatch.setenv("AGENT_SERVER_DB_MAX_OVERFLOW", "3")
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_TIMEOUT", "4.5")
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_RECYCLE", "600")

    engine = build_engine(
        url="postgresql+asyncpg://agents:secret@127.0.0.1:5432/agents"
    )
    try:
        assert engine.pool.size() == 7
        assert engine.pool._max_overflow == 3
        assert engine.pool._timeout == 4.5
        assert engine.pool._recycle == 600
        assert engine.pool._pre_ping is True
    finally:
        asyncio.run(engine.dispose())


def test_invalid_postgres_pool_setting_is_rejected(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_SERVER_DB_NULL_POOL", raising=False)
    monkeypatch.setenv("AGENT_SERVER_DB_POOL_SIZE", "0")

    with pytest.raises(ValueError, match="AGENT_SERVER_DB_POOL_SIZE"):
        build_engine(url="postgresql+asyncpg://agents:secret@127.0.0.1:5432/agents")


def test_invalid_migration_lock_timeout_is_rejected(tmp_path, monkeypatch, fresh_database_url) -> None:
    monkeypatch.setenv("AGENT_SERVER_MIGRATION_LOCK_TIMEOUT", "never")

    with pytest.raises(DatabaseMigrationError, match="must be a number"):
        upgrade_database(db_url=fresh_database_url)


def _seed_v2_13_runtime_storage(url) -> None:
    upgrade_database(db_url=url, revision="v2_13")
    engine = create_engine(_sync_url(url))
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO users "
                    "(id, password_hash, role, disabled, created_at, updated_at) "
                    "VALUES ('user_runtime_storage', 'hash', 'member', 0, :now, :now)"
                ),
                {"now": "2026-08-24T13:38:00Z"},
            )
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


def test_v2_35_replaces_the_session_item_time_index(fresh_database_url) -> None:
    url = fresh_database_url
    upgrade_database(db_url=url, revision="v2_34")

    def index_names() -> set[str]:
        engine = create_engine(_sync_url(url))
        try:
            with engine.connect() as connection:
                return {
                    row[0]
                    for row in connection.execute(
                        text(
                            "SELECT indexname FROM pg_indexes "
                            "WHERE tablename = 'timeline_items'"
                        )
                    )
                }
        finally:
            engine.dispose()

    assert "idx_timeline_items_session_item_time" in index_names()
    assert "idx_timeline_items_session_latest" not in index_names()

    upgrade_database(db_url=url, revision="v2_35")

    names = index_names()
    assert "idx_timeline_items_session_latest" in names
    assert "idx_timeline_items_session_item_time" not in names
    # The remaining timeline indexes must survive the swap.
    assert {
        "idx_timeline_items_session_updated_seq",
        "idx_timeline_items_session_order_seq",
        "idx_timeline_items_item_time_type_role",
    }.issubset(names)

    engine = create_engine(_sync_url(url))
    try:
        with engine.connect() as connection:
            definition = connection.execute(
                text(
                    "SELECT indexdef FROM pg_indexes "
                    "WHERE indexname = 'idx_timeline_items_session_latest'"
                )
            ).scalar_one()
        assert "COALESCE(item_time, ''::text) DESC" in definition
        assert "order_seq DESC" in definition
        assert "updated_seq DESC" in definition
    finally:
        engine.dispose()
