"""Add quota-limited cloud drive metadata & per-account policy tables.

Revision ID: v3_1
Revises: v3_0
Create Date: 2026-11-22
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "v3_1"
down_revision = "v3_0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())

    if "drive_user_policies" not in existing:
        op.create_table(
            "drive_user_policies",
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("quota_bytes", sa.BigInteger()),
            sa.Column("max_file_bytes", sa.BigInteger()),
            sa.Column("default_ttl_seconds", sa.Integer()),
            sa.Column("max_ttl_seconds", sa.Integer()),
            sa.Column("updated_by", sa.Text()),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )

    if "drive_files" not in existing:
        op.create_table(
            "drive_files",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("purpose", sa.Text(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("object_key", sa.Text(), nullable=False, unique=True),
            sa.Column("size_bytes", sa.BigInteger(), nullable=False),
            sa.Column("sha256", sa.Text(), nullable=False),
            sa.Column("etag", sa.Text()),
            sa.Column("filename", sa.Text()),
            sa.Column("mime_type", sa.Text()),
            sa.Column("vfs_path", sa.Text()),
            sa.Column("encryption_mode", sa.Text(), nullable=False, server_default="none"),
            sa.Column("encryption_nonce", sa.Text()),
            sa.Column("encryption_key_version", sa.Integer()),
            sa.Column("encrypted_meta", sa.Text()),
            sa.Column("source_device_id", sa.Text()),
            sa.Column("ttl_seconds", sa.Integer(), nullable=False),
            sa.Column("upload_expires_at", sa.BigInteger(), nullable=False),
            sa.Column("expires_at", sa.BigInteger(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("completed_at", sa.Text()),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )
        op.create_index("idx_drive_files_user_status_exp", "drive_files", ["user_id", "status", "expires_at"])
        op.create_index("idx_drive_files_user_vfs", "drive_files", ["user_id", "purpose", "vfs_path"])
        op.create_index("idx_drive_files_status_exp", "drive_files", ["status", "expires_at"])
        op.create_index("idx_drive_files_status_upload_exp", "drive_files", ["status", "upload_expires_at"])


def downgrade() -> None:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())
    if "drive_files" in existing:
        op.drop_table("drive_files")
    if "drive_user_policies" in existing:
        op.drop_table("drive_user_policies")
