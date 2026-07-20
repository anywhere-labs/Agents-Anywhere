from __future__ import annotations

from sqlalchemy import (
    Column,
    ForeignKey,
    Float,
    Index,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
)

metadata = MetaData()


connectors = Table(
    "connectors",
    metadata,
    Column("id", Text, primary_key=True),
    Column("user_id", Text, nullable=False),
    Column("name", Text, nullable=False),
    Column("device_os", Text),
    Column("status", Text, nullable=False),
    Column("last_seen_at", Text),
    Column("token_hash", Text, nullable=False),
    Column("token_prefix", Text, nullable=False),
    Column("revoked", Integer, nullable=False, server_default="0"),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    # JSON blob written by the daemon to mirror the user's local agent
    # preferences (e.g. ~/.claude/settings.json fields). Read-only from the
    # backend's perspective; the daemon owns the write loop.
    Column("user_preferences", Text),
    # JSON blob written by the daemon after local runtime discovery. Includes
    # per-runtime history/execution capability checks and selected binary paths.
    Column("runtime_capabilities", Text),
)


device_agent_settings = Table(
    "device_agent_settings",
    metadata,
    Column("connector_id", Text, ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
    Column("runtime", Text, nullable=False),
    Column("settings_json", Text, nullable=False),
    Column("schema_version", Integer, nullable=False),
    Column("updated_at", Text, nullable=False),
    PrimaryKeyConstraint("connector_id", "runtime"),
)


def _agent_catalog_table(name: str) -> Table:
    return Table(
        name,
        metadata,
        Column("runtime", Text, nullable=False),
        Column("key", Text, nullable=False),
        Column("display_label", Text, nullable=False),
        Column("description", Text),
        Column("is_default", Integer, nullable=False, server_default="0"),
        Column("sort_order", Integer, nullable=False),
        PrimaryKeyConstraint("runtime", "key"),
    )


# Per-runtime catalogs that drive the mode / model / effort dropdowns in the
# session composer. Rows are seeded on startup and treated as read-only by the
# rest of the backend.
agent_modes = _agent_catalog_table("agent_modes")
agent_models = _agent_catalog_table("agent_models")
agent_efforts = _agent_catalog_table("agent_efforts")


user_agent_defaults = Table(
    "user_agent_defaults",
    metadata,
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("runtime", Text, nullable=False),
    Column("enabled", Integer, nullable=False),
    Column("settings_json", Text, nullable=False),
    Column("models_json", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    PrimaryKeyConstraint("user_id", "runtime"),
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
    Column("connector_id", Text, ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
    Column("root", Text, nullable=False),
    Column("path", Text, nullable=False),
    Column("expires_at", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("consumed_at", Text),
)


connector_terminal_roots = Table(
    "connector_terminal_roots",
    metadata,
    Column("connector_id", Text, ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
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


sessions = Table(
    "sessions",
    metadata,
    Column("id", Text, primary_key=True),
    Column("connector_id", Text, ForeignKey("connectors.id"), nullable=False),
    Column("runtime", Text, nullable=False),
    Column("origin", Text, nullable=False, server_default="connector_import"),
    Column("runtime_settings_override", Text),
    Column("external_session_id", Text),
    Column("title", Text),
    Column("cwd", Text),
    Column("status", Text, nullable=False),
    Column("takeover", Integer, nullable=False),
    Column("pinned", Integer, nullable=False, server_default="0"),
    Column("pinned_at", Text),
    Column("archived", Integer, nullable=False, server_default="0"),
    Column("archived_at", Text),
    Column("last_read_seq", Integer, nullable=False, server_default="0"),
    Column("last_synced_at", Text),
    Column("source_observed_at", Text),
    Column("last_activity_at", Text),
    Column("seq", Integer, nullable=False),
    Column("updated_seq", Integer, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)


session_active_runs = Table(
    "session_active_runs",
    metadata,
    Column("session_id", Text, ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True),
    Column("runtime", Text, nullable=False),
    Column("external_session_id", Text),
    Column("turn_id", Text),
    Column("status", Text, nullable=False),
    Column("params_json", Text),
    Column("started_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)


timeline_items = Table(
    "timeline_items",
    metadata,
    Column("session_id", Text, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
    Column("id", Text, nullable=False),
    Column("type", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("role", Text),
    Column("turn_id", Text),
    Column("order_seq", Integer, nullable=False),
    Column("updated_seq", Integer, nullable=False),
    Column("item_time", Text),
    Column("payload_json", Text, nullable=False),
    PrimaryKeyConstraint("session_id", "id"),
    Index("idx_timeline_items_session_updated_seq", "session_id", "updated_seq"),
    Index("idx_timeline_items_session_item_time", "session_id", "item_time"),
    Index("idx_timeline_items_item_time_type_role", "item_time", "type", "role"),
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
    Column("turns", Integer, nullable=False, server_default="0"),
    Column("active_sessions", Integer, nullable=False, server_default="0"),
    Column("created_sessions", Integer, nullable=False, server_default="0"),
    Column("devices", Integer, nullable=False, server_default="0"),
    Column("macos_devices", Integer, nullable=False, server_default="0"),
    Column("windows_devices", Integer, nullable=False, server_default="0"),
    Column("linux_devices", Integer, nullable=False, server_default="0"),
    Column("unknown_devices", Integer, nullable=False, server_default="0"),
    Column("codex_agents", Integer, nullable=False, server_default="0"),
    Column("claude_agents", Integer, nullable=False, server_default="0"),
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


approvals = Table(
    "approvals",
    metadata,
    Column("id", Text, primary_key=True),
    Column("session_id", Text, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
    Column("turn_id", Text),
    Column("status", Text, nullable=False),
    Column("kind", Text, nullable=False),
    Column("target_item_id", Text),
    Column("title", Text, nullable=False),
    Column("description", Text),
    Column("payload_json", Text, nullable=False),
    Column("choices_json", Text, nullable=False),
    Column("source_json", Text, nullable=False),
    Column("updated_seq", Integer, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("resolved_at", Text),
)


notices = Table(
    "notices",
    metadata,
    Column("id", Text, primary_key=True),
    Column("session_id", Text, ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False),
    Column("type", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("interaction_type", Text),
    Column("blocking_json", Text),
    Column("response_required", Integer, nullable=False, server_default="0"),
    Column("severity", Text, nullable=False),
    Column("title", Text, nullable=False),
    Column("message", Text),
    Column("source_json", Text, nullable=False),
    Column("actions_json", Text, nullable=False),
    Column("context_json", Text, nullable=False),
    Column("metadata_json", Text, nullable=False),
    Column("revision", Integer, nullable=False),
    Column("updated_seq", Integer, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    Column("expires_at", Text),
    Column("resolved_at", Text),
    Index("idx_notices_session_status", "session_id", "status"),
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
