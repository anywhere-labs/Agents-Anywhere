from __future__ import annotations

import os
from pathlib import Path

import sqlalchemy as sa
from alembic import command
from alembic.config import Config

from aa_control.core.auth import hash_password, verify_password

ALEMBIC_INI = Path(__file__).parents[1] / "alembic.ini"


def _seed_legacy_v2_tables(conn: sa.Connection) -> None:
    """Create representative v2_56 tables (users, oauth_accounts, sessions, timeline_items, instance_settings, etc.)."""
    pw_hash = hash_password("legacy-v2-password", iterations=1_000)
    conn.execute(
        sa.text(
            """
            CREATE TABLE users (
                id TEXT PRIMARY KEY,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'member',
                disabled INTEGER NOT NULL DEFAULT 0,
                email TEXT,
                email_verified_at TEXT,
                display_name TEXT NOT NULL DEFAULT '',
                avatar TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
    )
    conn.execute(
        sa.text(
            """
            CREATE TABLE oauth_accounts (
                provider TEXT NOT NULL,
                subject TEXT NOT NULL,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                email TEXT,
                display_name TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (provider, subject)
            )
            """
        )
    )
    # Representative v2 tables that MUST be removed by v3_0
    for stmt in (
        "CREATE TABLE instance_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "CREATE TABLE connectors (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)",
        "CREATE TABLE projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)",
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT)",
        "CREATE TABLE timeline_items (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, body TEXT)",
        "CREATE TABLE usage_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)",
        "CREATE TABLE model_profiles (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)",
        "CREATE TABLE tokens_links (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)",
    ):
        conn.execute(sa.text(stmt))

    conn.execute(
        sa.text(
            "INSERT INTO users (id, password_hash, role, disabled, email, display_name, created_at, updated_at) "
            "VALUES ('usr_legacy_1', :pw, 'admin', 0, 'legacy@example.com', 'Legacy Admin', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
        ),
        {"pw": pw_hash},
    )
    conn.execute(
        sa.text(
            "INSERT INTO oauth_accounts (provider, subject, user_id, email, display_name, created_at, updated_at) "
            "VALUES ('github', 'gh_42', 'usr_legacy_1', 'legacy@example.com', 'Legacy Admin', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
        )
    )
    conn.execute(sa.text("INSERT INTO instance_settings (key, value) VALUES ('registration_open', 'false')"))
    conn.execute(sa.text("INSERT INTO sessions (id, user_id, title) VALUES ('sess_old', 'usr_legacy_1', 'Old chat')"))
    conn.execute(sa.text("INSERT INTO timeline_items (id, session_id, body) VALUES ('ti_1', 'sess_old', 'Secret chat')"))


def test_v3_0_migration_preserves_users_and_drops_all_v2_tables(tmp_path: Path) -> None:
    pg_url = os.environ.get("AA_CONTROL_TEST_DB_URL")
    if pg_url:
        assert "test" in pg_url.lower()
        sync_url = pg_url.replace("postgresql+asyncpg://", "postgresql+psycopg://")
        engine = sa.create_engine(sync_url)
        # Clean slate before seeding legacy v2 tables
        with engine.begin() as conn:
            conn.execute(sa.text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
    else:
        db_file = tmp_path / "v2_upgrade.sqlite"
        engine = sa.create_engine(f"sqlite:///{db_file}")

    try:
        with engine.begin() as conn:
            _seed_legacy_v2_tables(conn)

        cfg = Config(str(ALEMBIC_INI))
        cfg.set_main_option("script_location", str(ALEMBIC_INI.parent / "migrations"))
        with engine.begin() as conn:
            cfg.attributes["connection"] = conn
            command.upgrade(cfg, "head")

        inspector = sa.inspect(engine)
        tables = set(inspector.get_table_names())

        # Legacy tables MUST be gone (including instance_settings & conversation tables)
        for dropped in (
            "instance_settings",
            "connectors",
            "projects",
            "sessions",
            "timeline_items",
            "usage_events",
            "model_profiles",
            "tokens_links",
        ):
            assert dropped not in tables

        # V3 control-plane tables MUST exist
        for required in (
            "users",
            "oauth_accounts",
            "refresh_tokens",
            "devices",
            "device_credentials",
            "clients",
            "mcp_oauth_clients",
            "mcp_auth_codes",
            "mcp_grants",
            "audit_logs",
        ):
            assert required in tables

        # Existing v2 user & oauth account MUST be intact and password still verifies
        with engine.connect() as conn:
            user = conn.execute(sa.text("SELECT id, email, password_hash, role FROM users WHERE id = 'usr_legacy_1'")).mappings().one()
            assert user["email"] == "legacy@example.com"
            assert user["role"] == "admin"
            assert verify_password("legacy-v2-password", user["password_hash"], iterations=1_000)

            oauth = conn.execute(sa.text("SELECT provider, subject, user_id FROM oauth_accounts")).mappings().one()
            assert oauth["provider"] == "github"
            assert oauth["subject"] == "gh_42"
            assert oauth["user_id"] == "usr_legacy_1"
    finally:
        engine.dispose()
