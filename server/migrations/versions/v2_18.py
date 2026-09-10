"""Track latest turn-end read waterline.

Revision ID: v2_18
Revises: v2_17
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "v2_18"
down_revision: str | None = "v2_17"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")}
    if "latest_turn_end_seq" not in columns:
        op.add_column(
            "sessions",
            sa.Column(
                "latest_turn_end_seq",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
        )


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")}
    if "latest_turn_end_seq" in columns:
        op.drop_column("sessions", "latest_turn_end_seq")
