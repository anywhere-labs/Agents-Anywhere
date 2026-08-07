from __future__ import annotations

import asyncio
import hashlib
import json

import pytest
from sqlalchemy import BigInteger, create_engine, inspect, text
from sqlalchemy.ext.asyncio import create_async_engine

from agent_server.infra.db.engine import build_engine, resolve_db_url
from agent_server.infra.db.legacy_import import rehearse_v1_import
from agent_server.infra.db.migrations import (
    CURRENT_SCHEMA_REVISION,
    DatabaseMigrationError,
    database_revision,
    require_current_database,
    upgrade_database,
)
from agent_server.infra.db.schema import (
    connector_protocol_capabilities,
    connector_runtime_catalogs,
    metadata,
)


def _sqlite_url(path) -> str:
    return f"sqlite+aiosqlite:///{path}"


def test_protocol_clock_revisions_use_64_bit_columns() -> None:
    assert isinstance(connector_protocol_capabilities.c.revision.type, BigInteger)
    assert isinstance(connector_runtime_catalogs.c.revision.type, BigInteger)


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
        assert {"alembic_version", "device_runtimes", "sessions"}.issubset(
            tables
        )
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
            assert connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one() == CURRENT_SCHEMA_REVISION
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
            assert connection.execute(
                text("SELECT version_num FROM alembic_version")
            ).scalar_one() == target_revision
    finally:
        engine.dispose()


def test_current_schema_drops_legacy_approval_notice_storage(tmp_path) -> None:
    path = tmp_path / "approval-v2-2.sqlite3"
    upgrade_database(db_url=_sqlite_url(path), revision="v2_2")
    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            notice_id = "notice_approval_" + hashlib.sha256(
                json.dumps(
                    ("appr_migrate",),
                    ensure_ascii=False,
                    sort_keys=True,
                    default=str,
                ).encode("utf-8")
            ).hexdigest()[:24]
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


def _create_legacy_v1_database(path) -> None:
    engine = create_engine(f"sqlite:///{path}")
    metadata.create_all(engine)
    with engine.begin() as connection:
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
        connection.execute(
            text("ALTER TABLE connectors DROP COLUMN presence_instance_id")
        )
        connection.execute(
            text("ALTER TABLE connectors DROP COLUMN presence_connection_id")
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
