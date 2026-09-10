"""Separate DSH source visibility from user archive state.

Revision ID: v2_12
Revises: v2_11
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_12"
down_revision: str | None = "v2_11"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")
    }
    if "source_state" not in columns:
        op.add_column(
            "sessions",
            sa.Column(
                "source_state",
                sa.Text(),
                nullable=False,
                server_default="visible",
            ),
        )
    if "source_state_at" not in columns:
        op.add_column("sessions", sa.Column("source_state_at", sa.Text()))
    if "source_scan_token" not in columns:
        op.add_column("sessions", sa.Column("source_scan_token", sa.Text()))
    indexes = {
        index["name"] for index in sa.inspect(op.get_bind()).get_indexes("sessions")
    }
    if "idx_sessions_connector_runtime_source_state" not in indexes:
        op.create_index(
            "idx_sessions_connector_runtime_source_state",
            "sessions",
            ["connector_id", "runtime", "source_state"],
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    indexes = {index["name"] for index in inspector.get_indexes("sessions")}
    if "idx_sessions_connector_runtime_source_state" in indexes:
        op.drop_index(
            "idx_sessions_connector_runtime_source_state", table_name="sessions"
        )
    columns = {column["name"] for column in inspector.get_columns("sessions")}
    if "source_scan_token" in columns:
        op.drop_column("sessions", "source_scan_token")
    if "source_state_at" in columns:
        op.drop_column("sessions", "source_state_at")
    if "source_state" in columns:
        op.drop_column("sessions", "source_state")
