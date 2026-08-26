"""Persist stable session list ordering.

Revision ID: v2_19
Revises: v2_18
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "v2_19"
down_revision: str | None = "v2_18"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")}
    if "sort_at" not in columns:
        op.add_column("sessions", sa.Column("sort_at", sa.Text(), nullable=True))
    op.execute(
        sa.text(
            """
            UPDATE sessions
            SET sort_at = COALESCE(
                (
                    SELECT timeline_items.item_time
                    FROM timeline_items
                    WHERE timeline_items.session_id = sessions.id
                    ORDER BY COALESCE(timeline_items.item_time, '') DESC,
                             timeline_items.order_seq DESC,
                             timeline_items.updated_seq DESC
                    LIMIT 1
                ),
                sessions.last_activity_at,
                sessions.created_at
            )
            WHERE sort_at IS NULL
            """
        )
    )


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")}
    if "sort_at" in columns:
        op.drop_column("sessions", "sort_at")
