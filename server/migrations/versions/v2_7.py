"""Drop persisted runtime notices.

Revision ID: v2_7
Revises: v2_6
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_7"
down_revision: str | None = "v2_6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if "notices" in set(sa.inspect(bind).get_table_names()):
        op.drop_table("notices")


def downgrade() -> None:
    bind = op.get_bind()
    if "notices" in set(sa.inspect(bind).get_table_names()):
        return
    op.create_table(
        "notices",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Text(),
            sa.ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("interaction_type", sa.Text(), nullable=True),
        sa.Column("blocking_json", sa.Text(), nullable=True),
        sa.Column("response_required", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("severity", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("source_json", sa.Text(), nullable=False),
        sa.Column("actions_json", sa.Text(), nullable=False),
        sa.Column("context_json", sa.Text(), nullable=False),
        sa.Column("metadata_json", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("updated_seq", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.Text(), nullable=True),
        sa.Column("resolved_at", sa.Text(), nullable=True),
    )
    op.create_index("idx_notices_session_status", "notices", ["session_id", "status"])
