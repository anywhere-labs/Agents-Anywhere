from __future__ import annotations

from sqlalchemy import (
    BigInteger,
    Column,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    PrimaryKeyConstraint,
    Table,
    Text,
)

metadata = MetaData()

# ---------------------------------------------------------------------------
# Retained from v2 (exact column compatibility for in-place 3.0 migration)
# ---------------------------------------------------------------------------

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
    Column("avatar", Text),
    Column("created_at", Text, nullable=False),
    Column("updated_at", Text, nullable=False),
    Index("idx_users_email", "email", unique=True),
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

# ---------------------------------------------------------------------------
# AA v3 lightweight control-plane tables (ZERO conversation content)
# ---------------------------------------------------------------------------

refresh_tokens = Table(
    "refresh_tokens",
    metadata,
    Column("id", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("client_id", Text, nullable=False),
    Column("token_hash", Text, nullable=False, unique=True),
    Column("expires_at", BigInteger, nullable=False),
    Column("revoked_at", Text),
    Column("created_at", Text, nullable=False),
    Index("idx_refresh_tokens_user_id", "user_id"),
)

devices = Table(
    "devices",
    metadata,
    Column("id", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("name", Text, nullable=False),
    Column("platform", Text, nullable=False),
    Column("connector_version", Text, nullable=False),
    Column("mode_hint", Text, nullable=False, server_default="normal"),
    Column("e2e_public_key_hint", Text),
    Column("created_at", Text, nullable=False),
    Column("last_seen_at", Text, nullable=False),
    Index("idx_devices_user_id", "user_id"),
)

device_credentials = Table(
    "device_credentials",
    metadata,
    Column("device_id", Text, ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True),
    Column("secret_hash", Text, nullable=False),
    Column("rotated_at", Text, nullable=False),
    Column("revoked_at", Text),
)

clients = Table(
    "clients",
    metadata,
    Column("id", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("platform", Text, nullable=False),
    Column("label", Text, nullable=False, server_default=""),
    Column("push_token", Text),
    Column("created_at", Text, nullable=False),
    Column("last_seen_at", Text, nullable=False),
    Index("idx_clients_user_id", "user_id"),
)

mcp_oauth_clients = Table(
    "mcp_oauth_clients",
    metadata,
    Column("client_id", Text, primary_key=True),
    Column("client_name", Text, nullable=False),
    Column("redirect_uris_json", Text, nullable=False),
    Column("client_secret_hash", Text),
    Column("created_at", Text, nullable=False),
)

mcp_auth_codes = Table(
    "mcp_auth_codes",
    metadata,
    Column("code_hash", Text, primary_key=True),
    Column("client_id", Text, ForeignKey("mcp_oauth_clients.client_id", ondelete="CASCADE"), nullable=False),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("redirect_uri", Text, nullable=False),
    Column("code_challenge", Text, nullable=False),
    Column("scopes_json", Text, nullable=False),
    Column("device_ids_json", Text, nullable=False),
    Column("expires_at", BigInteger, nullable=False),
    Column("consumed_at", Text),
    Column("created_at", Text, nullable=False),
)

mcp_grants = Table(
    "mcp_grants",
    metadata,
    Column("id", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("client_id", Text, ForeignKey("mcp_oauth_clients.client_id", ondelete="CASCADE"), nullable=False),
    Column("client_name", Text, nullable=False),
    Column("scopes_json", Text, nullable=False),
    Column("device_ids_json", Text, nullable=False),
    Column("access_token_hash", Text, nullable=False, unique=True),
    Column("expires_at", BigInteger, nullable=False),
    Column("revoked_at", Text),
    Column("created_at", Text, nullable=False),
    Index("idx_mcp_grants_user_id", "user_id"),
)

audit_logs = Table(
    "audit_logs",
    metadata,
    Column("id", Text, primary_key=True),
    Column("user_id", Text, nullable=False),
    Column("actor", Text, nullable=False),
    Column("action", Text, nullable=False),
    Column("device_id", Text),
    Column("session_id", Text),
    Column("metadata_json", Text, nullable=False, server_default="{}"),
    Column("created_at", Text, nullable=False),
    Index("idx_audit_logs_user_created", "user_id", "created_at"),
)

# ---------------------------------------------------------------------------
# Quota-limited cloud drive & large-file relay tables (v3_1)
# ---------------------------------------------------------------------------

drive_user_policies = Table(
    "drive_user_policies",
    metadata,
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    Column("quota_bytes", BigInteger),
    Column("max_file_bytes", BigInteger),
    Column("default_ttl_seconds", Integer),
    Column("max_ttl_seconds", Integer),
    Column("updated_by", Text),
    Column("updated_at", Text, nullable=False),
)

drive_files = Table(
    "drive_files",
    metadata,
    Column("id", Text, primary_key=True),
    Column("user_id", Text, ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
    Column("purpose", Text, nullable=False),
    Column("status", Text, nullable=False),
    Column("object_key", Text, nullable=False, unique=True),
    Column("size_bytes", BigInteger, nullable=False),
    Column("sha256", Text, nullable=False),
    Column("etag", Text),
    Column("filename", Text),
    Column("mime_type", Text),
    Column("vfs_path", Text),
    Column("encryption_mode", Text, nullable=False, server_default="none"),
    Column("encryption_nonce", Text),
    Column("encryption_key_version", Integer),
    Column("encrypted_meta", Text),
    Column("source_device_id", Text),
    Column("ttl_seconds", Integer, nullable=False),
    Column("upload_expires_at", BigInteger, nullable=False),
    Column("expires_at", BigInteger, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("completed_at", Text),
    Column("updated_at", Text, nullable=False),
    Index("idx_drive_files_user_status_exp", "user_id", "status", "expires_at"),
    Index("idx_drive_files_user_vfs", "user_id", "purpose", "vfs_path"),
    Index("idx_drive_files_status_exp", "status", "expires_at"),
    Index("idx_drive_files_status_upload_exp", "status", "upload_expires_at"),
)
