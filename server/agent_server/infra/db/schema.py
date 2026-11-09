from __future__ import annotations

from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    Sequence,
    Table,
    Text,
    UniqueConstraint,
    false,
    text,
)

metadata = MetaData()


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
    # JSON blob written by the daemon to mirror the user's local agent
    # preferences (e.g. ~/.claude/settings.json fields). Read-only from the
    # backend's perspective; the daemon owns the write loop.
    Column("user_preferences", Text),
    Index("idx_connectors_user_revoked", "user_id", "revoked"),
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
    # Optional step inside a non-error status (e.g. syncing while starting).
    Column("phase_json", Text),
    # Last model connection report from the runtime adapter (v2_50).
    Column("model_connection_json", Text),
    # "model-config" on instances the model configuration created (v2_50).
    Column("managed_by", Text),
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


retired_device_runtimes = Table(
    "retired_device_runtimes",
    metadata,
    Column("connector_id", Text, ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
    Column("runtime_id", Text, nullable=False),
    Column("retired_at", Text, nullable=False),
    PrimaryKeyConstraint("connector_id", "runtime_id"),
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
    Column("email", Text),
    Column("email_verified_at", Text),
    Column("display_name", Text, nullable=False, server_default=""),
    Index("idx_users_email", "email", unique=True),
    # Optional avatar stored inline as a data URL (image/png base64). Capped at
    # ~256 KB by the upload endpoint; small enough to keep in the row.
    Column("avatar", Text),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
)


email_verification_codes = Table(
    "email_verification_codes",
    metadata,
    Column("scope", Text, primary_key=True),
    Column("email", Text, nullable=False),
    Column("purpose", Text, nullable=False),
    Column("user_id", Text, nullable=False),
    Column("code_hash", Text, nullable=False),
    Column("nonce", Text, nullable=False),
    Column("sent_at", BigInteger, nullable=False),
    Column("expires_at", BigInteger, nullable=False),
    Column("failed_attempts", Integer, nullable=False, server_default="0"),
    Column("attempt_window", BigInteger, nullable=False),
    Column("consumed_at", BigInteger),
    Index("idx_email_codes_sent_at", "sent_at"),
)

email_verification_limits = Table(
    "email_verification_limits",
    metadata,
    Column("key", Text, primary_key=True),
    Column("window_start", BigInteger, nullable=False),
    Column("count", Integer, nullable=False),
    Index("idx_email_limits_window", "window_start"),
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
    Column("manually_created", Boolean, nullable=False, server_default=false()),
    Column("pinned", Integer, nullable=False, server_default="0"),
    Column("pinned_at", Text),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
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
    UniqueConstraint(
        "user_id",
        "connector_id",
        "workspace_key",
        name="uq_projects_user_connector_workspace",
    ),
    UniqueConstraint(
        "user_id",
        "name",
        name="uq_projects_user_name",
    ),
)


session_source_change_seq = Sequence("session_source_change_seq", metadata=metadata)

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
            ondelete="RESTRICT",
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
    Column("title_source", Text),
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
    # Retired by v2_49 and kept only so the previous release can roll back.
    Column("source_scan_token", Text),
    # Sequence value of the last source observation that an inventory scan which
    # began earlier must not overwrite. NULL means older than any scan.
    Column(
        "source_changed_seq",
        BigInteger,
        server_default=text("nextval('session_source_change_seq')"),
    ),
    Column("last_read_seq", BigInteger, nullable=False, server_default="0"),
    Column("latest_turn_end_seq", BigInteger, nullable=False, server_default="0"),
    Column("timeline_reset_seq", BigInteger, nullable=False, server_default="0"),
    Column("last_synced_at", Text),
    Column("source_observed_at", Text),
    Column("last_activity_at", Text),
    Column("sort_at", Text),
    # Summary of the newest timeline row (same order as
    # ``idx_timeline_items_session_latest``), kept current by every timeline
    # write so session lists never look into ``timeline_items``. All NULL when
    # the session has no timeline rows.
    Column("latest_item_id", Text),
    Column("latest_item_time", Text),
    Column("latest_item_order_seq", Integer),
    Column("latest_item_updated_seq", BigInteger),
    Column("latest_item_at", Text),
    Column("seq", BigInteger, nullable=False),
    Column("seq_allocated_high", BigInteger, nullable=False, server_default="0"),
    Column("updated_seq", BigInteger, nullable=False),
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


session_inventory_scans = Table(
    "session_inventory_scans",
    metadata,
    Column(
        "connector_id",
        Text,
        ForeignKey("connectors.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("runtime", Text, primary_key=True),
    Column("runtime_id", Text, primary_key=True),
    Column("scan_token", Text, nullable=False),
    Column("started_seq", BigInteger, nullable=False),
    Column("started_at", Text, nullable=False),
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
    Column("updated_seq", BigInteger, nullable=False),
    Column("item_time", Text),
    Column("payload_json", Text, nullable=False),
    PrimaryKeyConstraint("session_id", "id"),
    Index("idx_timeline_items_session_updated_seq", "session_id", "updated_seq"),
    Index(
        "idx_timeline_items_session_latest",
        "session_id",
        text("coalesce(item_time, '') DESC"),
        text("order_seq DESC"),
        text("updated_seq DESC"),
    ),
    Index(
        "idx_timeline_items_session_order_seq",
        "session_id",
        "order_seq",
    ),
)


session_shares = Table(
    "session_shares",
    metadata,
    Column("id", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column(
        "session_id",
        Text,
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("scope", Text, nullable=False),
    Column("snapshot_json", Text, nullable=False),
    Column("allowed_file_ids_json", Text, nullable=False, server_default="[]"),
    Column("created_at", Text, nullable=False),
    Index("idx_session_shares_user_created", "user_id", "created_at"),
    Index("idx_session_shares_session_created", "session_id", "created_at"),
)


# Append-only usage facts recorded at the moment platform activity happens.
# `hour_bucket` is the UTC hour (`YYYY-MM-DDTHH`) so reports can aggregate in
# SQL and map hours onto local days for any requested timezone in Python.
# Connector and session ids are plain text on purpose: a device or session may
# be deleted later while its usage history must survive.
usage_events = Table(
    "usage_events",
    metadata,
    Column("id", Text, primary_key=True),
    Column("occurred_at", Text, nullable=False),
    Column("hour_bucket", Text, nullable=False),
    Column("event_type", Text, nullable=False),
    Column("user_id", Text, ForeignKey("users.id", ondelete="SET NULL")),
    Column("connector_id", Text),
    Column("session_id", Text),
    Column("runtime_type", Text),
    Column("runtime_id", Text),
    Column("device_os", Text),
    Column("outcome", Text),
    Column("duration_ms", Integer),
    Column("dedupe_key", Text),
    UniqueConstraint("dedupe_key", name="uq_usage_events_dedupe_key"),
    Index("idx_usage_events_hour", "hour_bucket"),
    Index("idx_usage_events_type_hour", "event_type", "hour_bucket"),
    Index("idx_usage_events_session_time", "session_id", "occurred_at"),
    Index("idx_usage_events_user_hour", "user_id", "hour_bucket"),
)


# Hourly rollups of `usage_events`, updated in the same transaction as every
# event insert so they stay exact however late an event arrives. The report
# reads these instead of scanning raw events; only duration percentiles still
# need the raw rows. Absent optional keys are stored as "" so they can be part
# of the primary key. Rows keyed by user cascade on user deletion, matching the
# raw events whose `user_id` becomes NULL.
usage_hourly_counts = Table(
    "usage_hourly_counts",
    metadata,
    Column("hour_bucket", Text, nullable=False),
    Column("event_type", Text, nullable=False),
    Column("runtime_type", Text, nullable=False, server_default=""),
    Column("outcome", Text, nullable=False, server_default=""),
    Column("count", BigInteger, nullable=False),
    Column("duration_sum", BigInteger, nullable=False),
    PrimaryKeyConstraint("hour_bucket", "event_type", "runtime_type", "outcome"),
)

usage_hourly_users = Table(
    "usage_hourly_users",
    metadata,
    Column("hour_bucket", Text, nullable=False),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("messages", BigInteger, nullable=False),
    PrimaryKeyConstraint("hour_bucket", "user_id"),
)

usage_hourly_sessions = Table(
    "usage_hourly_sessions",
    metadata,
    Column("hour_bucket", Text, nullable=False),
    Column("session_id", Text, nullable=False),
    Column("messages", BigInteger, nullable=False),
    Column("views", BigInteger, nullable=False),
    PrimaryKeyConstraint("hour_bucket", "session_id"),
)

usage_hourly_runtime_sessions = Table(
    "usage_hourly_runtime_sessions",
    metadata,
    Column("hour_bucket", Text, nullable=False),
    Column("runtime_type", Text, nullable=False),
    Column("session_id", Text, nullable=False),
    PrimaryKeyConstraint("hour_bucket", "runtime_type", "session_id"),
)

usage_hourly_runtime_users = Table(
    "usage_hourly_runtime_users",
    metadata,
    Column("hour_bucket", Text, nullable=False),
    Column("runtime_type", Text, nullable=False),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    PrimaryKeyConstraint("hour_bucket", "runtime_type", "user_id"),
)

usage_hourly_connectors = Table(
    "usage_hourly_connectors",
    metadata,
    Column("hour_bucket", Text, nullable=False),
    Column("connector_id", Text, nullable=False),
    Column("device_os", Text),
    PrimaryKeyConstraint("hour_bucket", "connector_id"),
)


# Daily stock metrics (users, devices, configured runtimes) captured once per
# UTC day by the usage maintenance loop. Flow metrics live in `usage_events`.
usage_inventory_snapshots = Table(
    "usage_inventory_snapshots",
    metadata,
    Column("snapshot_date", Text, nullable=False),
    Column("metric_key", Text, nullable=False),
    Column("dimension", Text, nullable=False, server_default=""),
    Column("value", Float, nullable=False),
    Column("computed_at", Text, nullable=False),
    PrimaryKeyConstraint("snapshot_date", "metric_key", "dimension"),
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


runtime_workflows = Table(
    "runtime_workflows", metadata,
    Column("user_id", Text, primary_key=True), Column("kind", Text, primary_key=True), Column("id", Text, primary_key=True),
    Column("connector_id", Text, ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
    Column("runtime_id", Text, nullable=False), Column("runtime_type", Text, nullable=False),
    Column("project_id", Text, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False), Column("session_id", Text),
    Column("input_digest", Text, nullable=False), Column("request_json", Text, nullable=False),
    Column("result_json", Text, nullable=False), Column("consumed_by", Text),
)


session_runtime_event_receipts = Table(
    "session_runtime_event_receipts", metadata,
    Column("session_id", Text, ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True),
    Column("source_event_id", Text, primary_key=True),
    Column("event_digest", Text, nullable=False),
)
session_planning = Table("session_planning", metadata,
    Column("session_id", Text, ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True),
    Column("payload", Text, nullable=False))
plan_documents = Table("plan_documents", metadata,
    Column("session_id", Text, ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True),
    Column("plan_id", Text, primary_key=True), Column("revision", Integer, primary_key=True),
    Column("content_hash", Text, nullable=False), Column("payload", Text, nullable=False), Column("created_at", Text, nullable=False))
planning_operations = Table("planning_operations", metadata,
    Column("session_id", Text, ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True),
    Column("operation_id", Text, primary_key=True), Column("fingerprint", Text, nullable=False), Column("payload", Text, nullable=False))

planning_creations = Table("planning_creations", metadata,
    Column("connector_id", Text, ForeignKey("connectors.id", ondelete="CASCADE"), primary_key=True),
    Column("runtime_id", Text, primary_key=True), Column("operation_id", Text, primary_key=True),
    Column("fingerprint", Text, nullable=False), Column("payload", Text, nullable=False))


tokens_links = Table("tokens_links", metadata,
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("issuer", Text, nullable=False), Column("account_json", Text, nullable=False),
    Column("status", Text, nullable=False), Column("refresh_token_ciphertext", Text),
    Column("linked_at", Text, nullable=False), Column("refreshed_at", Text),
    Column("issued_at", Text, nullable=False), Column("quick_setup_json", Text))
tokens_link_states = Table("tokens_link_states", metadata,
    Column("state_hash", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("ticket_hash", Text, nullable=False, unique=True), Column("browser_hash", Text),
    Column("code_verifier_ciphertext", Text, nullable=False), Column("issuer", Text, nullable=False),
    Column("redirect_uri", Text, nullable=False), Column("created_at", Text, nullable=False),
    Column("expires_at", Text, nullable=False), Column("consumed_at", Text),
    Column("quick_setup_json", Text))
model_profiles = Table("model_profiles", metadata,
    Column("id", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("source", Text, nullable=False), Column("name", Text, nullable=False),
    Column("origin_host", Text, nullable=False), Column("offers_json", Text, nullable=False),
    Column("catalog_digest", Text, nullable=False), Column("key_ref_json", Text, nullable=False),
    Column("secret_ciphertext", Text), Column("preferences_json", Text), Column("state", Text, nullable=False),
    Column("connection_revision", BigInteger, nullable=False, server_default="1"),
    Column("etag", Integer, nullable=False), Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    Index("idx_model_profiles_user_id", "user_id"))
runtime_model_assignments = Table("runtime_model_assignments", metadata,
    Column("connector_id", Text, nullable=False), Column("runtime_id", Text, nullable=False),
    Column("profile_id", Text, ForeignKey("model_profiles.id", ondelete="RESTRICT"), nullable=False),
    Column("offer_format", Text, nullable=False),
    Column("created_runtime", Integer, nullable=False, server_default="0"),
    Column("applied_digest", Text, nullable=False), Column("applied_catalog_digest", Text, nullable=False),
    Column("imported_model_ids_json", Text, nullable=False), Column("previous_gateway_ciphertext", Text),
    Column("status", Text, nullable=False), Column("error_json", Text), Column("applied_at", Text),
    Column("updated_at", Text, nullable=False),
    PrimaryKeyConstraint("connector_id", "runtime_id"),
    ForeignKeyConstraint(["connector_id", "runtime_id"],
        ["device_runtimes.connector_id", "device_runtimes.runtime_id"], ondelete="CASCADE"),
    Index("idx_runtime_model_assignments_profile_id", "profile_id"))
model_channel_selections = Table("model_channel_selections", metadata,
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("channel", Text, nullable=False), Column("revision", Integer, nullable=False),
    Column("updated_at", Text, nullable=False))
runtime_channel_overrides = Table("runtime_channel_overrides", metadata,
    Column("connector_id", Text, nullable=False), Column("runtime_id", Text, nullable=False),
    Column("channel", Text, nullable=False),
    Column("confirm_native_global", Integer, nullable=False, server_default="0"),
    Column("updated_at", Text, nullable=False),
    PrimaryKeyConstraint("connector_id", "runtime_id"),
    ForeignKeyConstraint(["connector_id", "runtime_id"],
        ["device_runtimes.connector_id", "device_runtimes.runtime_id"], ondelete="CASCADE"))
runtime_channel_switches = Table("runtime_channel_switches", metadata,
    Column("connector_id", Text, nullable=False), Column("runtime_id", Text, nullable=False),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("state", Text, nullable=False), Column("step", Text), Column("target_channel", Text),
    Column("reason", Text), Column("message", Text),
    Column("snapshot_ciphertext", Text),
    Column("switch_revision", BigInteger, nullable=False, server_default="0"),
    Column("target_generation", BigInteger), Column("target_spec_digest", Text),
    Column("expected_config_digest", Text), Column("plan_ciphertext", Text),
    Column("lease_owner", Text), Column("lease_epoch", BigInteger, nullable=False, server_default="0"),
    Column("operation_id", Text), Column("lease_until", Text),
    Column("started_at", Text), Column("updated_at", Text, nullable=False),
    PrimaryKeyConstraint("connector_id", "runtime_id"),
    ForeignKeyConstraint(["connector_id", "runtime_id"],
        ["device_runtimes.connector_id", "device_runtimes.runtime_id"], ondelete="CASCADE"),
    Index("idx_runtime_channel_switches_user_id", "user_id"))
runtime_admissions = Table("runtime_admissions", metadata,
    Column("token", Text, primary_key=True),
    Column("connector_id", Text, nullable=False), Column("runtime_id", Text, nullable=False),
    Column("expires_at", Text, nullable=False),
    Index("idx_runtime_admissions_runtime", "connector_id", "runtime_id"))

# Desired state is independent of the transaction currently applying it.
runtime_channel_sync = Table("runtime_channel_sync", metadata,
    Column("connector_id", Text, nullable=False), Column("runtime_id", Text, nullable=False),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("desired_generation", BigInteger, nullable=False, server_default="1"),
    Column("desired_channel", Text, nullable=False), Column("desired_spec_digest", Text, nullable=False),
    Column("applied_generation", BigInteger), Column("actual_channel", Text),
    Column("actual_config_digest", Text), Column("observed_instance_id", Text), Column("observed_at", Text),
    Column("retry_count", Integer, nullable=False, server_default="0"), Column("next_retry_at", Text),
    Column("last_error_code", Text), Column("last_error_at", Text), Column("updated_at", Text, nullable=False),
    PrimaryKeyConstraint("connector_id", "runtime_id"),
    ForeignKeyConstraint(["connector_id", "runtime_id"],
        ["device_runtimes.connector_id", "device_runtimes.runtime_id"], ondelete="CASCADE"),
    CheckConstraint("applied_generation IS NULL OR applied_generation <= desired_generation"),
    Index("idx_channel_sync_user", "user_id"),
    Index("idx_channel_sync_retry", "next_retry_at"),
    Index("idx_channel_sync_due", "connector_id", "runtime_id",
          postgresql_where=text("applied_generation IS DISTINCT FROM desired_generation")))
channel_sync_outbox = Table("channel_sync_outbox", metadata,
    Column("id", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("connector_id", Text, ForeignKey("connectors.id", ondelete="CASCADE"), nullable=False),
    Column("created_at", Text, nullable=False), Column("next_attempt_at", Text, nullable=False),
    Column("attempts", Integer, nullable=False, server_default="0"),
    Column("claim_owner", Text), Column("claim_until", Text), Column("delivered_at", Text),
    Index("idx_channel_outbox_pending", "next_attempt_at", postgresql_where=text("delivered_at IS NULL")))
channel_device_fences = Table("channel_device_fences", metadata,
    Column("connector_id", Text, ForeignKey("connectors.id", ondelete="CASCADE"), primary_key=True),
    Column("revision", BigInteger, nullable=False, server_default="0"))
channel_rotation_intents = Table("channel_rotation_intents", metadata,
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("profile_id", Text, nullable=False), Column("key_id", Text, nullable=False),
    Column("state", Text, nullable=False), Column("updated_at", Text, nullable=False))

channel_device_gates = Table("channel_device_gates", metadata,
    Column("connector_id", Text, ForeignKey("connectors.id", ondelete="CASCADE"), primary_key=True),
    Column("connection_id", Text, nullable=False), Column("expires_at", Text, nullable=False))
from agent_server.infra.db.goal_schema import define_goal_tables

session_goals, session_goal_state, goal_operations, goal_event_outbox = (
    define_goal_tables(metadata)
)
