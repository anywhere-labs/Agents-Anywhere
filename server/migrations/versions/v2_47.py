"""Durable unified goal state, operation journal and event outbox.

Revision ID: v2_47
Revises: v2_46
"""

from alembic import op

revision = "v2_47"
down_revision = "v2_46"
branch_labels = None
depends_on = None


def upgrade():
    op.execute(
        """
CREATE TABLE session_goals (
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 goal_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','paused','blocked','usageLimited','budgetLimited','complete','failed','cleared','replaced')),
 source_revision BIGINT NOT NULL CHECK(source_revision >= 0), payload TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
 PRIMARY KEY(session_id,goal_id),
 CHECK ((status IN ('complete','failed','cleared','replaced')) = (ended_at IS NOT NULL))
)
"""
    )
    op.execute(
        "CREATE INDEX ix_goal_history ON session_goals(session_id,created_at,goal_id)"
    )
    op.execute(
        "CREATE UNIQUE INDEX ux_goal_current ON session_goals(session_id) WHERE ended_at IS NULL"
    )
    op.execute(
        """
CREATE TABLE session_goal_state (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
 current_goal_id TEXT, last_outcome_goal_id TEXT, revision BIGINT NOT NULL DEFAULT 0 CHECK(revision >= 0),
 binding_generation BIGINT NOT NULL DEFAULT 0 CHECK(binding_generation >= 0), source_epoch TEXT,
 source_revision BIGINT NOT NULL DEFAULT 0 CHECK(source_revision >= 0), payload TEXT NOT NULL,
 observed_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 FOREIGN KEY(session_id,current_goal_id) REFERENCES session_goals(session_id,goal_id),
 FOREIGN KEY(session_id,last_outcome_goal_id) REFERENCES session_goals(session_id,goal_id)
)
"""
    )
    op.execute(
        """
CREATE TABLE goal_operations (
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, operation_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('set','edit','pause','resume','clear')),
 expected_revision BIGINT NOT NULL CHECK(expected_revision >= 0), binding_generation BIGINT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','confirmed','rejected','unknown')),
 request_payload TEXT NOT NULL, result_payload TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
 PRIMARY KEY(session_id,operation_id)
)
"""
    )
    op.execute(
        "CREATE INDEX ix_goal_operations_pending ON goal_operations(session_id,created_at) WHERE state IN ('reserved','dispatched','unknown')"
    )
    op.execute(
        """
CREATE TABLE goal_event_outbox (
 event_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 state_revision BIGINT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL, claim_owner TEXT, claim_until TEXT, delivered_at TEXT,
 UNIQUE(session_id,state_revision,kind)
)
"""
    )
    op.execute(
        "CREATE INDEX ix_goal_outbox_pending ON goal_event_outbox(next_attempt_at,created_at) WHERE delivered_at IS NULL"
    )


def downgrade():
    for name in (
        "goal_event_outbox",
        "goal_operations",
        "session_goal_state",
        "session_goals",
    ):
        op.drop_table(name)
