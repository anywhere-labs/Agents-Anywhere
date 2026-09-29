"""Add the RFC 8628 device authorization grant for headless plug-in sign-in.

A plug-in on a headless or SSH host cannot receive a ``127.0.0.1`` loopback
callback, so it starts a device authorization request instead: it shows a short
user code, the user approves the code from an already signed-in web session, and
the plug-in polls for the access token.  Only the hashes of the device code and
the user code are stored.

Revision ID: v2_38
Revises: v2_37
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_38"
down_revision: str | None = "v2_37"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

USER_CODE_INDEX = "idx_oauth_device_codes_user_code_hash"


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("oauth_device_codes"):
        op.create_table(
            "oauth_device_codes",
            sa.Column("device_code_hash", sa.Text(), primary_key=True),
            sa.Column("user_code_hash", sa.Text(), nullable=False),
            sa.Column("client_id", sa.Text(), nullable=False),
            sa.Column("scope", sa.Text(), nullable=False),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column(
                "user_id",
                sa.Text(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
            ),
            sa.Column("interval_seconds", sa.Integer(), nullable=False),
            sa.Column("expires_at", sa.Text(), nullable=False),
            sa.Column("last_polled_at", sa.Text()),
            sa.Column("approved_at", sa.Text()),
            sa.Column("consumed_at", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
        )
    # SQLite DDL is not transactional, so a crash between the CREATE TABLE and the
    # CREATE INDEX left the index missing and a re-run used to skip it.  Guard the
    # index on its own existence, the same way v2_38 guards its column.
    indexes = {index["name"] for index in inspector.get_indexes("oauth_device_codes")}
    if USER_CODE_INDEX not in indexes:
        op.create_index(USER_CODE_INDEX, "oauth_device_codes", ["user_code_hash"])
    if not inspector.has_table("oauth_device_code_attempts"):
        op.create_table(
            "oauth_device_code_attempts",
            sa.Column(
                "user_id",
                sa.Text(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column(
                "failed_attempts",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
            sa.Column("window_start", sa.BigInteger(), nullable=False),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("oauth_device_code_attempts"):
        op.drop_table("oauth_device_code_attempts")
    if inspector.has_table("oauth_device_codes"):
        indexes = {index["name"] for index in inspector.get_indexes("oauth_device_codes")}
        if USER_CODE_INDEX in indexes:
            op.drop_index(USER_CODE_INDEX, table_name="oauth_device_codes")
        op.drop_table("oauth_device_codes")
