"""Persist per-session message queues.

Revision ID: v2_21
Revises: v2_20
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "v2_21"
down_revision: str | None = "v2_20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    session_columns = {column["name"] for column in inspector.get_columns("sessions")}
    if "message_queue_updated_seq" not in session_columns:
        op.add_column(
            "sessions",
            sa.Column(
                "message_queue_updated_seq",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
        )

    if "session_message_queue" in inspector.get_table_names():
        return
    op.create_table(
        "session_message_queue",
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("client_message_id", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("attachments_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("selections_json", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("position", sa.BigInteger(), nullable=False),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_error_json", sa.Text(), nullable=True),
        sa.Column("claimed_at", sa.Text(), nullable=True),
        sa.Column("dispatched_at", sa.Text(), nullable=True),
        sa.Column("updated_seq", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "session_id",
            "client_message_id",
            name="uq_session_message_queue_client_message",
        ),
    )
    op.create_index(
        "idx_session_message_queue_session_status_position",
        "session_message_queue",
        ["session_id", "status", "position"],
        unique=False,
    )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "session_message_queue" in inspector.get_table_names():
        indexes = {
            index["name"]
            for index in inspector.get_indexes("session_message_queue")
        }
        if "idx_session_message_queue_session_status_position" in indexes:
            op.drop_index(
                "idx_session_message_queue_session_status_position",
                table_name="session_message_queue",
            )
        op.drop_table("session_message_queue")
    session_columns = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")
    }
    if "message_queue_updated_seq" in session_columns:
        op.drop_column("sessions", "message_queue_updated_seq")
