"""Add email account identity and verification storage without converting users.

Revision ID: v2_25
Revises: v2_24
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_25"
down_revision: str | None = "v2_24"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("email", sa.Text()))
    op.add_column("users", sa.Column("email_verified_at", sa.Text()))
    op.add_column(
        "users", sa.Column("display_name", sa.Text(), nullable=False, server_default="")
    )
    op.create_index("idx_users_email", "users", ["email"], unique=True)
    op.create_table(
        "email_verification_codes",
        sa.Column("scope", sa.Text(), primary_key=True),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("purpose", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("nonce", sa.Text(), nullable=False),
        sa.Column("sent_at", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=False),
        sa.Column("failed_attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("attempt_window", sa.BigInteger(), nullable=False),
        sa.Column("consumed_at", sa.BigInteger()),
    )
    op.create_table(
        "email_verification_limits",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("window_start", sa.BigInteger(), nullable=False),
        sa.Column("count", sa.Integer(), nullable=False),
    )

    op.create_index("idx_email_codes_sent_at", "email_verification_codes", ["sent_at"])
    op.create_index(
        "idx_email_limits_window", "email_verification_limits", ["window_start"]
    )


def downgrade() -> None:
    if (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT 1 FROM users WHERE email IS NOT NULL OR display_name <> '' LIMIT 1"
            )
        )
        .first()
    ):
        raise RuntimeError("cannot downgrade while email account data exists")
    op.drop_table("email_verification_limits")
    op.drop_table("email_verification_codes")
    op.drop_index("idx_users_email", table_name="users")
    op.drop_column("users", "display_name")
    op.drop_column("users", "email_verified_at")
    op.drop_column("users", "email")
