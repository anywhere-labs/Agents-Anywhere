from __future__ import annotations

from typing import Any

from sqlalchemy import (
    BigInteger,
    Column,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
    UniqueConstraint,
)

metadata = MetaData()


app_releases = Table(
    "app_releases",
    metadata,
    Column("platform", Text, nullable=False),
    Column("version_code", Integer, nullable=False),
    Column("version_name", Text, nullable=False),
    Column("download_url", Text),
    Column("published", Integer, nullable=False, server_default="0"),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    PrimaryKeyConstraint("platform", "version_code"),
)


def _legacy_runtime_id_default(context: Any) -> str:
    runtime = context.get_current_parameters().get("runtime")
    if not isinstance(runtime, str) or not runtime:
        raise ValueError("runtime is required when runtime_id is omitted")
    return runtime


connectors = Table(
    "connectors",
    metadata,
    Column("id", Text, primary_key=True),
    Column("user_id", Text, nullable=False),
    Column("name", Text, nullable=False),
    Column("connector_kind", Text, nullable=False, server_default="cli"),
    Column("device_os", Text),
    Column("status", Text, nullable=False),
    Column("presence_instance_id", Text),
    Column("presence_connection_id", Text),
    Column("last_seen_at", Text),
    Column("token_hash", Text, nullable=False),
    Column("token_prefix", Text, nullable=False),
    Column("revoked", Integer, nullable=False, server_default="0"),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    Column(
        "runtime_control_version",
        Text,
        nullable=False,
        server_default="1.0",
    ),
    # JSON blob written by the daemon to mirror the user's local agent
    # preferences (e.g. ~/.claude/settings.json fields). Read-only from the
    # backend's perspective; the daemon owns the write loop.
    Column("user_preferences", Text),
)


connector_runtime_types = Table(
    "connector_runtime_types",
    metadata,
    Column(
        "connector_id",
        Text,
        ForeignKey("connectors.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("runtime_type", Text, nullable=False),
    Column("implementation_type", Text, nullable=False),
    Column("display_name", Text, nullable=False),
    Column("description", Text),
    Column("present", Integer, nullable=False, server_default="1"),
    Column("available", Integer, nullable=False, server_default="1"),
    Column("reason", Text),
    Column("recommended", Integer, nullable=False, server_default="0"),
    Column("recommendation_rank", Integer),
    Column("discovery_json", Text, nullable=False),
    Column("config_schema_json", Text),
    Column("ui_schema_json", Text),
    Column("defaults_json", Text, nullable=False),
    Column("capabilities_json", Text, nullable=False),
    Column("metadata_json", Text, nullable=False),
    Column("instance_policy", Text, nullable=False),
    Column("max_instances", BigInteger),
    Column("last_discovered_at", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    PrimaryKeyConstraint("connector_id", "runtime_type"),
)


device_runtimes = Table(
    "device_runtimes",
    metadata,
    Column(
        "connector_id",
        Text,
        ForeignKey("connectors.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("runtime_id", Text, nullable=False),
    Column("runtime_type", Text, nullable=False),
    Column("name", Text, nullable=False),
    Column("name_key", Text, nullable=False),
    # NULL means the runtime has not been configured. An empty JSON object is
    # a valid configured value and means "use every provider default".
    Column("config_json", Text),
    Column("active", Integer, nullable=False, server_default="0"),
    Column("status", Text, nullable=False, server_default="stopped"),
    Column("error_json", Text),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    PrimaryKeyConstraint("connector_id", "runtime_id"),
    UniqueConstraint("connector_id", "name_key"),
    ForeignKeyConstraint(
        ["connector_id", "runtime_type"],
        [
            "connector_runtime_types.connector_id",
            "connector_runtime_types.runtime_type",
        ],
        ondelete="CASCADE",
    ),
)


connector_runtime_catalogs = Table(
    "connector_runtime_catalogs",
    metadata,
    Column(
        "connector_id",
        Text,
        ForeignKey("connectors.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("runtime", Text, nullable=False),
    Column(
        "runtime_id",
        Text,
        nullable=False,
        default=_legacy_runtime_id_default,
    ),
    Column("catalog_type", Text, nullable=False),
    Column("revision", BigInteger, nullable=False),
    Column("catalog_json", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    PrimaryKeyConstraint("connector_id", "runtime_id", "catalog_type"),
)


connector_protocol_capabilities = Table(
    "connector_protocol_capabilities",
    metadata,
    Column(
        "connector_id",
        Text,
        ForeignKey("connectors.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("revision", BigInteger, nullable=False),
    Column("capabilities_json", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)


users = Table(
    "users",
    metadata,
    Column("id", Text, primary_key=True),
    Column("password_hash", Text, nullable=False),
    Column("role", Text, nullable=False, server_default="member"),
    Column("disabled", Integer, nullable=False, server_default="0"),
    # Optional avatar stored inline as a data URL (image/png base64). Capped at
    # ~256 KB by the upload endpoint; small enough to keep in the row.
    Column("avatar", Text),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)


platform_user_activity = Table(
    "platform_user_activity",
    metadata,
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("activity_date", Text, nullable=False),
    Column("first_seen_at", Text, nullable=False),
    Column("last_seen_at", Text, nullable=False),
    Column("event_count", Integer, nullable=False, server_default="0"),
    PrimaryKeyConstraint("user_id", "activity_date"),
    Index("idx_platform_user_activity_last_seen", "last_seen_at"),
)


oauth_accounts = Table(
    "oauth_accounts",
    metadata,
    Column("provider", Text, nullable=False),
    Column("subject", Text, nullable=False),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("email", Text),
    Column("display_name", Text),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    PrimaryKeyConstraint("provider", "subject"),
    Index("idx_oauth_accounts_user_id", "user_id"),
)


oauth_clients = Table(
    "oauth_clients",
    metadata,
    Column("id", Text, primary_key=True),
    Column("name", Text, nullable=False),
    Column("redirect_uris_json", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)


oauth_authorization_codes = Table(
    "oauth_authorization_codes",
    metadata,
    Column("code_hash", Text, primary_key=True),
    Column("client_id", Text, nullable=False),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("redirect_uri", Text, nullable=False),
    Column("scope", Text, nullable=False),
    Column("code_challenge", Text, nullable=False),
    Column("code_challenge_method", Text, nullable=False),
    Column("expires_at", Text, nullable=False),
    Column("consumed_at", Text),
    Column("created_at", Text, nullable=False),
)


mobile_login_tokens = Table(
    "mobile_login_tokens",
    metadata,
    Column("token_hash", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("device_name", Text),
    Column("expires_at", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("requested_at", Text),
    Column("approved_at", Text),
    Column("rejected_at", Text),
    Column("consumed_at", Text),
)


fs_preview_tokens = Table(
    "fs_preview_tokens",
    metadata,
    Column("token_hash", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column(
        "connector_id",
        Text,
        ForeignKey("connectors.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("root", Text, nullable=False),
    Column("path", Text, nullable=False),
    Column("expires_at", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("consumed_at", Text),
)


connector_terminal_roots = Table(
    "connector_terminal_roots",
    metadata,
    Column(
        "connector_id",
        Text,
        ForeignKey("connectors.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("terminal_id", Text, nullable=False),
    Column("session_id", Text, nullable=False),
    Column("root", Text, nullable=False),
    Column("cwd", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    PrimaryKeyConstraint("connector_id", "terminal_id"),
    Index("idx_connector_terminal_roots_session", "connector_id", "session_id"),
)


instance_settings = Table(
    "instance_settings",
    metadata,
    Column("key", Text, primary_key=True),
    Column("value", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)


legacy_import_archive = Table(
    "legacy_import_archive",
    metadata,
    Column("source_table", Text, nullable=False),
    Column("row_key", Text, nullable=False),
    Column("payload_json", Text, nullable=False),
    Column("archived_at", Text, nullable=False),
    PrimaryKeyConstraint("source_table", "row_key"),
)


projects = Table(
    "projects",
    metadata,
    Column("id", Text, primary_key=True),
    Column(
        "user_id",
        Text,
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column(
        "connector_id",
        Text,
        ForeignKey("connectors.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("name", Text, nullable=False),
    Column("workspace_path", Text, nullable=False),
    Column("workspace_key", Text, nullable=False),
    Column("pinned", Integer, nullable=False, server_default="0"),
    Column("pinned_at", Text),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    UniqueConstraint(
        "user_id",
        "connector_id",
        "workspace_key",
        name="uq_projects_user_connector_workspace",
    ),
    Index(
        "idx_projects_user_pinned_updated",
        "user_id",
        "pinned",
        "pinned_at",
        "updated_at",
    ),
    Index(
        "idx_projects_connector_workspace",
        "connector_id",
        "workspace_key",
    ),
)


sessions = Table(
    "sessions",
    metadata,
    Column("id", Text, primary_key=True),
    Column("connector_id", Text, ForeignKey("connectors.id"), nullable=False),
    Column(
        "project_id",
        Text,
        ForeignKey(
            "projects.id",
            name="fk_sessions_project_id_projects",
            ondelete="SET NULL",
        ),
    ),
    Column("runtime", Text, nullable=False),
    Column(
        "runtime_id",
        Text,
        nullable=False,
        default=_legacy_runtime_id_default,
    ),
    Column("origin", Text, nullable=False, server_default="connector_import"),
    Column("model_selection_id", Text),
    Column("permission_selection_id", Text),
    Column("external_session_id", Text),
    Column("title", Text),
    Column("cwd", Text),
    Column("status", Text, nullable=False),
    Column("takeover", Integer, nullable=False),
    Column("pinned", Integer, nullable=False, server_default="0"),
    Column("pinned_at", Text),
    Column("archived", Integer, nullable=False, server_default="0"),
    Column("archived_at", Text),
    Column("dsh_archive_legacy", Integer, nullable=False, server_default="0"),
    Column("source_state", Text, nullable=False, server_default="visible"),
    Column("source_state_at", Text),
    Column("source_state_reason", Text),
    Column("source_observation_origin", Text),
    Column("source_scan_token", Text),
    Column("last_read_seq", Integer, nullable=False, server_default="0"),
    Column("latest_turn_end_seq", Integer, nullable=False, server_default="0"),
    Column("timeline_reset_seq", Integer, nullable=False, server_default="0"),
    Column("last_synced_at", Text),
    Column("source_observed_at", Text),
    Column("last_activity_at", Text),
    Column("sort_at", Text),
    Column("seq", Integer, nullable=False),
    Column("updated_seq", Integer, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    Index(
        "idx_sessions_connector_runtime_source_state",
        "connector_id",
        "runtime",
        "source_state",
    ),
    Index(
        "idx_sessions_project_archived_sort",
        "project_id",
        "archived",
        "pinned",
        "sort_at",
    ),
)


session_active_runs = Table(
    "session_active_runs",
    metadata,
    Column(
        "session_id",
        Text,
        ForeignKey("sessions.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("runtime", Text, nullable=False),
    Column(
        "runtime_id",
        Text,
        nullable=False,
        default=_legacy_runtime_id_default,
    ),
    Column("external_session_id", Text),
    Column("status", Text, nullable=False),
    Column("params_json", Text),
    Column("started_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)


timeline_items = Table(
    "timeline_items",
    metadata,
    Column(
        "session_id",
        Text,
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("id", Text, nullable=False),
    Column("type", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("role", Text),
    Column("order_seq", Integer, nullable=False),
    Column("updated_seq", Integer, nullable=False),
    Column("item_time", Text),
    Column("payload_json", Text, nullable=False),
    PrimaryKeyConstraint("session_id", "id"),
    Index("idx_timeline_items_session_updated_seq", "session_id", "updated_seq"),
    Index("idx_timeline_items_session_item_time", "session_id", "item_time"),
    Index("idx_timeline_items_item_time_type_role", "item_time", "type", "role"),
)


session_shares = Table(
    "session_shares",
    metadata,
    Column("id", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("session_id", Text, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
    Column("scope", Text, nullable=False),
    Column("snapshot_json", Text, nullable=False),
    Column("allowed_file_ids_json", Text, nullable=False, server_default="[]"),
    Column("created_at", Text, nullable=False),
    Index("idx_session_shares_user_created", "user_id", "created_at"),
    Index("idx_session_shares_session_created", "session_id", "created_at"),
)


dashboard_daily_metrics = Table(
    "dashboard_daily_metrics",
    metadata,
    Column("date", Text, nullable=False),
    Column("metric_key", Text, nullable=False),
    Column("dimension_key", Text, nullable=False, server_default=""),
    Column("dimension_value", Text, nullable=False, server_default=""),
    Column("value", Float, nullable=False),
    Column("computed_at", Text, nullable=False),
    PrimaryKeyConstraint("date", "metric_key", "dimension_key", "dimension_value"),
    Index("idx_dashboard_daily_metrics_date", "date"),
)


dashboard_user_daily_facts = Table(
    "dashboard_user_daily_facts",
    metadata,
    Column("date", Text, nullable=False),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("messages", Integer, nullable=False, server_default="0"),
    Column("active_sessions", Integer, nullable=False, server_default="0"),
    Column("created_sessions", Integer, nullable=False, server_default="0"),
    Column("devices", Integer, nullable=False, server_default="0"),
    Column("macos_devices", Integer, nullable=False, server_default="0"),
    Column("windows_devices", Integer, nullable=False, server_default="0"),
    Column("linux_devices", Integer, nullable=False, server_default="0"),
    Column("unknown_devices", Integer, nullable=False, server_default="0"),
    Column("codex_agents", Integer, nullable=False, server_default="0"),
    Column("claude_agents", Integer, nullable=False, server_default="0"),
    Column("dsh_agents", Integer, nullable=False, server_default="0"),
    Column("last_activity_at", Text),
    Column("computed_at", Text, nullable=False),
    PrimaryKeyConstraint("date", "user_id"),
    Index("idx_dashboard_user_daily_facts_user_date", "user_id", "date"),
)


dashboard_settings = Table(
    "dashboard_settings",
    metadata,
    Column("key", Text, primary_key=True),
    Column("value_json", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)


pairing_codes = Table(
    "pairing_codes",
    metadata,
    Column("id", Text, primary_key=True),
    Column("code", Text, nullable=False, unique=True),
    Column("status", Text, nullable=False),
    Column("server_url", Text),
    Column("connector_id", Text),
    Column("connector_token", Text),
    Column("expires_at", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("claimed_at", Text),
    Column("consumed_at", Text),
)
