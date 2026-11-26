"""AA v3.0 control-plane baseline & v2 legacy table cleanup.

Revision ID: v3_0
Revises:
Create Date: 2026-11-21

Supports both:
1. Fresh installation on an empty database (creates users, oauth_accounts, and all v3 tables).
2. In-place 2.x -> 3.0.0 upgrade during a short maintenance window:
   - Preserves ``users`` and ``oauth_accounts`` intact.
   - Drops all v2 conversation/timeline/connector/usage/model-config/instance_settings tables.
   - Creates v3 lightweight control-plane tables (zero conversation content).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "v3_0"
down_revision = None
branch_labels = None
depends_on = None

# Ordered child-first so both PostgreSQL and SQLite drop cleanly without FK violations.
LEGACY_V2_TABLES: tuple[str, ...] = (
    # Timeline, sessions, shares, projects, planning, message queue, goals
    "timeline_items",
    "session_shares",
    "session_active_runs",
    "session_inventory_scans",
    "session_runtime_event_receipts",
    "planning_operations",
    "planning_creations",
    "plan_documents",
    "session_planning",
    "message_queue_items",
    "message_queue_state",
    "goal_outbox",
    "goal_operations",
    "goal_state",
    "goals",
    "sessions",
    "projects",
    "fs_preview_tokens",
    "connector_terminal_roots",
    "runtime_workflows",
    # Model config & channels
    "channel_device_gates",
    "channel_rotation_intents",
    "channel_device_fences",
    "channel_sync_outbox",
    "runtime_channel_sync",
    "runtime_admissions",
    "runtime_channel_switches",
    "runtime_channel_overrides",
    "model_channel_selections",
    "runtime_model_assignments",
    "model_profiles",
    # Connectors & runtimes (replaced by v3 devices + device_credentials)
    "device_runtimes",
    "retired_device_runtimes",
    "connector_runtime_types",
    "connector_runtime_catalogs",
    "connector_protocol_capabilities",
    "pairing_codes",
    "connectors",
    # Usage analytics
    "usage_events",
    "usage_hourly_counts",
    "usage_hourly_users",
    "usage_hourly_sessions",
    "usage_hourly_runtime_sessions",
    "usage_hourly_runtime_users",
    "usage_hourly_connectors",
    "usage_inventory_snapshots",
    # Tokens Anywhere links & legacy v2 OAuth / mobile / email / instance settings
    "tokens_links",
    "tokens_link_states",
    "oauth_authorization_codes",
    "oauth_clients",
    "mobile_login_tokens",
    "email_verification_codes",
    "email_verification_limits",
    "instance_settings",
    "legacy_import_archive",
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = set(inspector.get_table_names())
    is_postgres = bind.dialect.name == "postgresql"

    # 1. Drop all legacy v2 tables (never touching users or oauth_accounts).
    for table_name in LEGACY_V2_TABLES:
        if table_name in existing:
            if is_postgres:
                op.execute(sa.text(f'DROP TABLE IF EXISTS "{table_name}" CASCADE'))
            else:
                op.drop_table(table_name)

    # 2. Ensure users & oauth_accounts exist (preserved untouched on 2.x upgrades).
    if "users" not in existing:
        op.create_table(
            "users",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("password_hash", sa.Text(), nullable=False),
            sa.Column("role", sa.Text(), nullable=False, server_default="member"),
            sa.Column("disabled", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("email", sa.Text()),
            sa.Column("email_verified_at", sa.Text()),
            sa.Column("display_name", sa.Text(), nullable=False, server_default=""),
            sa.Column("avatar", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )
        op.create_index("idx_users_email", "users", ["email"], unique=True)

    if "oauth_accounts" not in existing:
        op.create_table(
            "oauth_accounts",
            sa.Column("provider", sa.Text(), nullable=False),
            sa.Column("subject", sa.Text(), nullable=False),
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("email", sa.Text()),
            sa.Column("display_name", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("provider", "subject"),
        )
        op.create_index("idx_oauth_accounts_user_id", "oauth_accounts", ["user_id"])

    # 3. Create v3 lightweight control-plane tables.
    if "refresh_tokens" not in existing:
        op.create_table(
            "refresh_tokens",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("client_id", sa.Text(), nullable=False),
            sa.Column("token_hash", sa.Text(), nullable=False, unique=True),
            sa.Column("expires_at", sa.BigInteger(), nullable=False),
            sa.Column("revoked_at", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
        )
        op.create_index("idx_refresh_tokens_user_id", "refresh_tokens", ["user_id"])

    if "devices" not in existing:
        op.create_table(
            "devices",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("platform", sa.Text(), nullable=False),
            sa.Column("connector_version", sa.Text(), nullable=False),
            sa.Column("mode_hint", sa.Text(), nullable=False, server_default="normal"),
            sa.Column("e2e_public_key_hint", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("last_seen_at", sa.Text(), nullable=False),
        )
        op.create_index("idx_devices_user_id", "devices", ["user_id"])

    if "device_credentials" not in existing:
        op.create_table(
            "device_credentials",
            sa.Column("device_id", sa.Text(), sa.ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("secret_hash", sa.Text(), nullable=False),
            sa.Column("rotated_at", sa.Text(), nullable=False),
            sa.Column("revoked_at", sa.Text()),
        )

    if "clients" not in existing:
        op.create_table(
            "clients",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("platform", sa.Text(), nullable=False),
            sa.Column("label", sa.Text(), nullable=False, server_default=""),
            sa.Column("push_token", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("last_seen_at", sa.Text(), nullable=False),
        )
        op.create_index("idx_clients_user_id", "clients", ["user_id"])

    if "mcp_oauth_clients" not in existing:
        op.create_table(
            "mcp_oauth_clients",
            sa.Column("client_id", sa.Text(), primary_key=True),
            sa.Column("client_name", sa.Text(), nullable=False),
            sa.Column("redirect_uris_json", sa.Text(), nullable=False),
            sa.Column("client_secret_hash", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
        )

    if "mcp_auth_codes" not in existing:
        op.create_table(
            "mcp_auth_codes",
            sa.Column("code_hash", sa.Text(), primary_key=True),
            sa.Column("client_id", sa.Text(), sa.ForeignKey("mcp_oauth_clients.client_id", ondelete="CASCADE"), nullable=False),
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("redirect_uri", sa.Text(), nullable=False),
            sa.Column("code_challenge", sa.Text(), nullable=False),
            sa.Column("scopes_json", sa.Text(), nullable=False),
            sa.Column("device_ids_json", sa.Text(), nullable=False),
            sa.Column("expires_at", sa.BigInteger(), nullable=False),
            sa.Column("consumed_at", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
        )

    if "mcp_grants" not in existing:
        op.create_table(
            "mcp_grants",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("client_id", sa.Text(), sa.ForeignKey("mcp_oauth_clients.client_id", ondelete="CASCADE"), nullable=False),
            sa.Column("client_name", sa.Text(), nullable=False),
            sa.Column("scopes_json", sa.Text(), nullable=False),
            sa.Column("device_ids_json", sa.Text(), nullable=False),
            sa.Column("access_token_hash", sa.Text(), nullable=False, unique=True),
            sa.Column("expires_at", sa.BigInteger(), nullable=False),
            sa.Column("revoked_at", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
        )
        op.create_index("idx_mcp_grants_user_id", "mcp_grants", ["user_id"])

    if "audit_logs" not in existing:
        op.create_table(
            "audit_logs",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("actor", sa.Text(), nullable=False),
            sa.Column("action", sa.Text(), nullable=False),
            sa.Column("device_id", sa.Text()),
            sa.Column("session_id", sa.Text()),
            sa.Column("metadata_json", sa.Text(), nullable=False, server_default="{}"),
            sa.Column("created_at", sa.Text(), nullable=False),
        )
        op.create_index("idx_audit_logs_user_created", "audit_logs", ["user_id", "created_at"])


def downgrade() -> None:
    raise RuntimeError(
        "AA v3.0 migration drops v2 conversation/timeline tables and is intentionally irreversible. "
        "Restore from the pre-migration pg_dump backup to roll back to 2.x."
    )
