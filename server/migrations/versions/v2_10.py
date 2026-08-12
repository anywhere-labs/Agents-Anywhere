"""Persist the latest complete timeline replacement revision.

Revision ID: v2_10
Revises: v2_9
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_10"
down_revision: str | None = "v2_9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")
    }
    if "timeline_reset_seq" not in columns:
        op.add_column(
            "sessions",
            sa.Column(
                "timeline_reset_seq",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
        )


def downgrade() -> None:
    columns = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")
    }
    if "timeline_reset_seq" in columns:
        op.drop_column("sessions", "timeline_reset_seq")
