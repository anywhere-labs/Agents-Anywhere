"""Goal persistence; native adapter details never become public protocol fields."""

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Column,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    PrimaryKeyConstraint,
    Table,
    Text,
    UniqueConstraint,
    text,
)


def define_goal_tables(metadata):
    goals = Table(
        "session_goals",
        metadata,
        Column(
            "session_id",
            Text,
            ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("goal_id", Text, nullable=False),
        Column("status", Text, nullable=False),
        Column("source_revision", BigInteger, nullable=False),
        Column("payload", Text, nullable=False),
        Column("created_at", Text, nullable=False),
        Column("updated_at", Text, nullable=False),
        Column("ended_at", Text),
        PrimaryKeyConstraint("session_id", "goal_id"),
        CheckConstraint("source_revision >= 0"),
        CheckConstraint(
            "status IN ('active','paused','blocked','usageLimited','budgetLimited','complete','failed','cleared','replaced')"
        ),
        CheckConstraint(
            "(status IN ('complete','failed','cleared','replaced')) = (ended_at IS NOT NULL)"
        ),
        Index("ix_goal_history", "session_id", "created_at", "goal_id"),
        Index(
            "ux_goal_current",
            "session_id",
            unique=True,
            postgresql_where=text("ended_at IS NULL"),
            sqlite_where=text("ended_at IS NULL"),
        ),
    )
    state = Table(
        "session_goal_state",
        metadata,
        Column(
            "session_id",
            Text,
            ForeignKey("sessions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        Column("current_goal_id", Text),
        Column("last_outcome_goal_id", Text),
        Column("revision", BigInteger, nullable=False, server_default="0"),
        Column("binding_generation", BigInteger, nullable=False, server_default="0"),
        Column("source_epoch", Text),
        Column("source_revision", BigInteger, nullable=False, server_default="0"),
        Column("payload", Text, nullable=False),
        Column("observed_at", Text, nullable=False),
        Column("updated_at", Text, nullable=False),
        CheckConstraint(
            "revision >= 0 AND source_revision >= 0 AND binding_generation >= 0"
        ),
        ForeignKeyConstraint(
            ["session_id", "current_goal_id"],
            ["session_goals.session_id", "session_goals.goal_id"],
        ),
        ForeignKeyConstraint(
            ["session_id", "last_outcome_goal_id"],
            ["session_goals.session_id", "session_goals.goal_id"],
        ),
    )
    operations = Table(
        "goal_operations",
        metadata,
        Column(
            "session_id",
            Text,
            ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("operation_id", Text, nullable=False),
        Column("fingerprint", Text, nullable=False),
        Column("action", Text, nullable=False),
        Column("expected_revision", BigInteger, nullable=False),
        Column("binding_generation", BigInteger, nullable=False),
        Column("state", Text, nullable=False),
        Column("request_payload", Text, nullable=False),
        Column("result_payload", Text),
        Column("created_at", Text, nullable=False),
        Column("updated_at", Text, nullable=False),
        Column("finished_at", Text),
        PrimaryKeyConstraint("session_id", "operation_id"),
        CheckConstraint("expected_revision >= 0"),
        CheckConstraint("action IN ('set','edit','pause','resume','clear')"),
        CheckConstraint(
            "state IN ('reserved','dispatched','confirmed','rejected','unknown')"
        ),
        Index(
            "ix_goal_operations_pending",
            "session_id",
            "created_at",
            postgresql_where=text("state IN ('reserved','dispatched','unknown')"),
        ),
    )
    outbox = Table(
        "goal_event_outbox",
        metadata,
        Column("event_id", Text, primary_key=True),
        Column(
            "session_id",
            Text,
            ForeignKey("sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        Column("state_revision", BigInteger, nullable=False),
        Column("kind", Text, nullable=False),
        Column("payload", Text, nullable=False),
        Column("created_at", Text, nullable=False),
        Column("attempts", Integer, nullable=False, server_default="0"),
        Column("next_attempt_at", Text, nullable=False),
        Column("claim_owner", Text),
        Column("claim_until", Text),
        Column("delivered_at", Text),
        UniqueConstraint("session_id", "state_revision", "kind"),
        Index(
            "ix_goal_outbox_pending",
            "next_attempt_at",
            "created_at",
            postgresql_where=text("delivered_at IS NULL"),
        ),
    )
    return goals, state, operations, outbox
