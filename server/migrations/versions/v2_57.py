"""Add authenticator-app two-step verification.

``user_totp`` keeps one encrypted secret per user. Until the user confirms
setup with a code, ``enabled_at`` stays NULL and sign-in is unchanged.
``user_totp_recovery_codes`` keeps hashes of single-use recovery codes.

Both tables are new; no existing rows are rewritten.

Revision ID: v2_57
Revises: v2_56
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_57"
down_revision = "v2_56"
branch_labels = None
depends_on = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "user_totp" not in tables:
        op.create_table(
            "user_totp",
            sa.Column(
                "user_id",
                sa.Text(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("secret_sealed", sa.Text(), nullable=False),
            sa.Column("enabled_at", sa.Text()),
            sa.Column("last_used_step", sa.BigInteger()),
            sa.Column("failed_attempts", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("locked_until", sa.BigInteger()),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )
    if "user_totp_recovery_codes" not in tables:
        op.create_table(
            "user_totp_recovery_codes",
            sa.Column(
                "user_id",
                sa.Text(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("code_hash", sa.Text(), primary_key=True),
            sa.Column("used_at", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("user_totp_recovery_codes")
    op.drop_table("user_totp")
