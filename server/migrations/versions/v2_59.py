"""Revocable login token families (security debt, ``05-server.md`` §8).

Every login now opens a token family: access tokens carry its id and refresh
tokens rotate inside it. Revoking the family (logout, password change, the
account being disabled) rejects every token of that login. Access tokens issued
before the upgrade carry no family and stay valid until they expire, but are
rejected as soon as their account is disabled or deleted.

Revision ID: v2_59
Revises: v2_58
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_59"
down_revision = "v2_58"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_token_families",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("client", sa.Text(), nullable=False, server_default=""),
        sa.Column("refresh_hash", sa.Text()),
        sa.Column("previous_refresh_hash", sa.Text()),
        sa.Column("refresh_expires_at", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("last_used_at", sa.Text(), nullable=False),
        sa.Column("revoked_at", sa.Text()),
        sa.Column("revoked_reason", sa.Text()),
    )
    op.create_index("idx_user_token_families_user", "user_token_families", ["user_id"])


def downgrade() -> None:
    op.drop_index("idx_user_token_families_user", table_name="user_token_families")
    op.drop_table("user_token_families")
