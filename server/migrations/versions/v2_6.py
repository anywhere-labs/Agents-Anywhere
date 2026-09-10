"""Drop durable runtime session state projection.

Revision ID: v2_6
Revises: v2_5
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_6"
down_revision: str | None = "v2_5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if "session_states" in set(sa.inspect(bind).get_table_names()):
        op.drop_table("session_states")


def downgrade() -> None:
    bind = op.get_bind()
    if "session_states" in set(sa.inspect(bind).get_table_names()):
        return
    op.create_table(
        "session_states",
        sa.Column(
            "session_id",
            sa.Text(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("runtime", sa.Text(), nullable=False),
        sa.Column("external_session_id", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("selections_json", sa.Text(), nullable=False),
        sa.Column("status_reason", sa.Text(), nullable=True),
        sa.Column("error_json", sa.Text(), nullable=True),
        sa.Column("metadata_json", sa.Text(), nullable=False),
        sa.Column("updated_seq", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
    )
