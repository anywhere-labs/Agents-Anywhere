"""Persist the server-owned per-session message queue.

Messages sent while a session is busy wait here and are dispatched by the
server once the session is idle again. ``session_queue_state`` carries one
revision per session so clients can order whole-queue snapshots, including the
transition back to an empty queue.

The tables are new; no existing rows are rewritten. The names differ from the
``session_message_queue`` schema that v2_21 created and v2_22 retired.

Revision ID: v2_56
Revises: v2_55
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_56"
down_revision = "v2_55"
branch_labels = None
depends_on = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "session_queued_messages" not in tables:
        op.create_table(
            "session_queued_messages",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column(
                "session_id",
                sa.Text(),
                sa.ForeignKey("sessions.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "created_by",
                sa.Text(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("client_message_id", sa.Text(), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            sa.Column("attachments_json", sa.Text(), nullable=False, server_default="[]"),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("position", sa.BigInteger(), nullable=False),
            sa.Column(
                "interrupt_requested",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
            sa.Column("interrupt_attempted_at", sa.Text()),
            sa.Column(
                "resume_requested",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
            sa.Column("claim_owner", sa.Text()),
            sa.Column("claimed_at", sa.Text()),
            sa.Column("error_json", sa.Text()),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.CheckConstraint(
                "status IN ('queued','sending','failed')",
                name="ck_session_queued_messages_status",
            ),
            sa.UniqueConstraint(
                "session_id",
                "client_message_id",
                name="uq_session_queued_messages_client_message",
            ),
        )
        op.create_index(
            "idx_session_queued_messages_session_position",
            "session_queued_messages",
            ["session_id", "position"],
        )
    if "session_queue_state" not in tables:
        op.create_table(
            "session_queue_state",
            sa.Column(
                "session_id",
                sa.Text(),
                sa.ForeignKey("sessions.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("revision", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )


def downgrade() -> None:
    op.drop_table("session_queue_state")
    op.drop_index(
        "idx_session_queued_messages_session_position",
        table_name="session_queued_messages",
    )
    op.drop_table("session_queued_messages")
