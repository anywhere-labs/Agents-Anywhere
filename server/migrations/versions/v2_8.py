"""Remove runtime turn ownership from active session runs.

Revision ID: v2_8
Revises: v2_7
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_8"
down_revision: str | None = "v2_7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    columns = {
        column["name"]
        for column in sa.inspect(bind).get_columns("session_active_runs")
    }
    if "turn_id" in columns:
        op.drop_column("session_active_runs", "turn_id")


def downgrade() -> None:
    bind = op.get_bind()
    columns = {
        column["name"]
        for column in sa.inspect(bind).get_columns("session_active_runs")
    }
    if "turn_id" not in columns:
        op.add_column(
            "session_active_runs",
            sa.Column("turn_id", sa.Text(), nullable=True),
        )
