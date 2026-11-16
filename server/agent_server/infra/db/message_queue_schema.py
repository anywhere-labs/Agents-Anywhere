"""Server-owned per-session message queue.

The table names deliberately differ from the ``session_message_queue`` schema
that v2_21 created and v2_22 retired: unversioned-database classification uses
that old table name as the v2_21 marker.
"""

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Column,
    ForeignKey,
    Index,
    Table,
    Text,
    UniqueConstraint,
    false,
)


def define_message_queue_tables(metadata):
    items = Table(
        "session_queued_messages",
        metadata,
        Column("id", Text, primary_key=True),
        Column(
            "session_id",
            Text,
            ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column(
            "created_by",
            Text,
            ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("client_message_id", Text, nullable=False),
        Column("content", Text, nullable=False),
        Column("attachments_json", Text, nullable=False, server_default="[]"),
        Column("status", Text, nullable=False),
        Column("position", BigInteger, nullable=False),
        Column(
            "interrupt_requested", Boolean, nullable=False, server_default=false()
        ),
        Column("interrupt_attempted_at", Text),
        Column("resume_requested", Boolean, nullable=False, server_default=false()),
        Column("claim_owner", Text),
        Column("claimed_at", Text),
        Column("error_json", Text),
        Column("created_at", Text, nullable=False),
        Column("updated_at", Text, nullable=False),
        CheckConstraint(
            "status IN ('queued','sending','failed')",
            name="ck_session_queued_messages_status",
        ),
        UniqueConstraint(
            "session_id",
            "client_message_id",
            name="uq_session_queued_messages_client_message",
        ),
        Index("idx_session_queued_messages_session_position", "session_id", "position"),
    )
    state = Table(
        "session_queue_state",
        metadata,
        Column(
            "session_id",
            Text,
            ForeignKey("sessions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        Column("revision", BigInteger, nullable=False, server_default="0"),
        Column("updated_at", Text, nullable=False),
    )
    return items, state
