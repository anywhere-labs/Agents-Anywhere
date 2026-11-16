"""Pairing codes move to Redis (security debt, ``05-server.md`` §8).

``pairing_codes`` kept the six-digit code and the issued Connector token in
plaintext and was never cleared. Pairings now live only in Redis for their TTL,
keyed by hashes, with the token sealed until the one poll that reads it.
Pairings in flight during the upgrade are dropped; the Connector starts a new one.

Revision ID: v2_58
Revises: v2_57
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_58"
down_revision = "v2_57"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("pairing_codes")


def downgrade() -> None:
    op.create_table(
        "pairing_codes",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("code", sa.Text(), nullable=False, unique=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("server_url", sa.Text()),
        sa.Column("connector_id", sa.Text()),
        sa.Column("connector_token", sa.Text()),
        sa.Column("expires_at", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("claimed_at", sa.Text()),
        sa.Column("consumed_at", sa.Text()),
    )
