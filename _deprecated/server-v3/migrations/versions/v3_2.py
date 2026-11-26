"""Add portable assistant conversation sync, KEK/DEK key envelope, and Tokens Anywhere connection tables.

Revision ID: v3_2
Revises: v3_1
Create Date: 2026-11-22
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "v3_2"
down_revision = "v3_1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())

    if "assistant_conversations" not in existing:
        op.create_table(
            "assistant_conversations",
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("conversation_id", sa.Text(), nullable=False),
            sa.Column("encrypted", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("title", sa.Text()),
            sa.Column("updated_at", sa.BigInteger(), nullable=False),
            sa.Column("content_hash", sa.Text(), nullable=False),
            sa.Column("device", sa.Text(), nullable=False),
            sa.Column("size_bytes", sa.BigInteger(), nullable=False),
            sa.Column("messages_json", sa.Text()),
            sa.Column("settings_json", sa.Text()),
            sa.Column("key_version", sa.Integer()),
            sa.Column("dek_epoch", sa.Integer()),
            sa.Column("nonce", sa.Text()),
            sa.Column("ciphertext", sa.Text()),
            sa.Column("encrypted_meta", sa.Text()),
            sa.Column("meta_nonce", sa.Text()),
            sa.Column("server_updated_at", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("user_id", "conversation_id"),
        )
        op.create_index(
            "idx_assistant_conv_user_updated",
            "assistant_conversations",
            ["user_id", "updated_at"],
        )

    if "assistant_key_envelopes" not in existing:
        op.create_table(
            "assistant_key_envelopes",
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("kdf", sa.Text(), nullable=False),
            sa.Column("kdf_params_json", sa.Text(), nullable=False),
            sa.Column("salt", sa.Text(), nullable=False),
            sa.Column("wrap_alg", sa.Text(), nullable=False, server_default="AES-256-GCM"),
            sa.Column("wrap_nonce", sa.Text()),
            sa.Column("wrapped_dek", sa.Text(), nullable=False),
            sa.Column("key_version", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("dek_epoch", sa.Integer(), nullable=False, server_default="1"),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )

    if "assistant_tokens_connections" not in existing:
        op.create_table(
            "assistant_tokens_connections",
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("key_enc", sa.Text(), nullable=False),
            sa.Column("key_hash", sa.Text(), nullable=False),
            sa.Column("key_prefix", sa.Text(), nullable=False),
            sa.Column("refresh_enc", sa.Text()),
            sa.Column("refreshed_at", sa.BigInteger(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )


def downgrade() -> None:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())
    if "assistant_tokens_connections" in existing:
        op.drop_table("assistant_tokens_connections")
    if "assistant_key_envelopes" in existing:
        op.drop_table("assistant_key_envelopes")
    if "assistant_conversations" in existing:
        op.drop_table("assistant_conversations")
