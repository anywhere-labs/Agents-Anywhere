"""Add hourly rollups of usage events for the admin usage report.

The report used to aggregate raw `usage_events` on every request, so its cost
grew with the number of events in the range. The Server now maintains hourly
rollups in the same transaction as each event insert; this revision creates
them and fills them from the events already recorded.

Revision ID: v2_45
Revises: v2_44
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_45"
down_revision = "v2_44"
branch_labels = None
depends_on = None

MESSAGE_SENT = "message.sent"
SESSION_VIEWED = "session.viewed"
CONNECTOR_ONLINE = "connector.online"

TABLES = (
    "usage_hourly_counts",
    "usage_hourly_users",
    "usage_hourly_sessions",
    "usage_hourly_runtime_sessions",
    "usage_hourly_runtime_users",
    "usage_hourly_connectors",
)

# Same rules as the write path in the usage repository.
BACKFILL = (
    """
    INSERT INTO usage_hourly_counts
        (hour_bucket, event_type, runtime_type, outcome, count, duration_sum)
    SELECT hour_bucket, event_type, coalesce(runtime_type, ''), coalesce(outcome, ''),
           count(*), coalesce(sum(duration_ms), 0)
    FROM usage_events
    GROUP BY 1, 2, 3, 4
    """,
    """
    INSERT INTO usage_hourly_users (hour_bucket, user_id, messages)
    SELECT hour_bucket, user_id, count(*) FILTER (WHERE event_type = :message)
    FROM usage_events
    WHERE user_id IS NOT NULL
    GROUP BY 1, 2
    """,
    """
    INSERT INTO usage_hourly_sessions (hour_bucket, session_id, messages, views)
    SELECT hour_bucket, session_id,
           count(*) FILTER (WHERE event_type = :message),
           count(*) FILTER (WHERE event_type = :viewed)
    FROM usage_events
    WHERE event_type IN (:message, :viewed) AND session_id IS NOT NULL
    GROUP BY 1, 2
    """,
    """
    INSERT INTO usage_hourly_runtime_sessions (hour_bucket, runtime_type, session_id)
    SELECT DISTINCT hour_bucket, runtime_type, session_id
    FROM usage_events
    WHERE event_type = :message AND session_id IS NOT NULL
      AND coalesce(runtime_type, '') <> ''
    """,
    """
    INSERT INTO usage_hourly_runtime_users (hour_bucket, runtime_type, user_id)
    SELECT DISTINCT hour_bucket, runtime_type, user_id
    FROM usage_events
    WHERE event_type = :message AND session_id IS NOT NULL
      AND coalesce(runtime_type, '') <> '' AND user_id IS NOT NULL
    """,
    """
    INSERT INTO usage_hourly_connectors (hour_bucket, connector_id, device_os)
    SELECT hour_bucket, connector_id, max(device_os)
    FROM usage_events
    WHERE event_type = :online AND connector_id IS NOT NULL
    GROUP BY 1, 2
    """,
)


def _user_fk() -> sa.ForeignKey:
    return sa.ForeignKey("users.id", ondelete="CASCADE")


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "usage_hourly_counts" not in tables:
        op.create_table(
            "usage_hourly_counts",
            sa.Column("hour_bucket", sa.Text(), nullable=False),
            sa.Column("event_type", sa.Text(), nullable=False),
            sa.Column("runtime_type", sa.Text(), nullable=False, server_default=""),
            sa.Column("outcome", sa.Text(), nullable=False, server_default=""),
            sa.Column("count", sa.BigInteger(), nullable=False),
            sa.Column("duration_sum", sa.BigInteger(), nullable=False),
            sa.PrimaryKeyConstraint("hour_bucket", "event_type", "runtime_type", "outcome"),
        )
    if "usage_hourly_users" not in tables:
        op.create_table(
            "usage_hourly_users",
            sa.Column("hour_bucket", sa.Text(), nullable=False),
            sa.Column("user_id", sa.Text(), _user_fk(), nullable=False),
            sa.Column("messages", sa.BigInteger(), nullable=False),
            sa.PrimaryKeyConstraint("hour_bucket", "user_id"),
        )
    if "usage_hourly_sessions" not in tables:
        op.create_table(
            "usage_hourly_sessions",
            sa.Column("hour_bucket", sa.Text(), nullable=False),
            sa.Column("session_id", sa.Text(), nullable=False),
            sa.Column("messages", sa.BigInteger(), nullable=False),
            sa.Column("views", sa.BigInteger(), nullable=False),
            sa.PrimaryKeyConstraint("hour_bucket", "session_id"),
        )
    if "usage_hourly_runtime_sessions" not in tables:
        op.create_table(
            "usage_hourly_runtime_sessions",
            sa.Column("hour_bucket", sa.Text(), nullable=False),
            sa.Column("runtime_type", sa.Text(), nullable=False),
            sa.Column("session_id", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("hour_bucket", "runtime_type", "session_id"),
        )
    if "usage_hourly_runtime_users" not in tables:
        op.create_table(
            "usage_hourly_runtime_users",
            sa.Column("hour_bucket", sa.Text(), nullable=False),
            sa.Column("runtime_type", sa.Text(), nullable=False),
            sa.Column("user_id", sa.Text(), _user_fk(), nullable=False),
            sa.PrimaryKeyConstraint("hour_bucket", "runtime_type", "user_id"),
        )
    if "usage_hourly_connectors" not in tables:
        op.create_table(
            "usage_hourly_connectors",
            sa.Column("hour_bucket", sa.Text(), nullable=False),
            sa.Column("connector_id", sa.Text(), nullable=False),
            sa.Column("device_os", sa.Text()),
            sa.PrimaryKeyConstraint("hour_bucket", "connector_id"),
        )

    bind = op.get_bind()
    for table in TABLES:
        bind.execute(sa.text(f"DELETE FROM {table}"))
    params = {"message": MESSAGE_SENT, "viewed": SESSION_VIEWED, "online": CONNECTOR_ONLINE}
    for statement in BACKFILL:
        bind.execute(sa.text(statement), params)


def downgrade() -> None:
    for table in reversed(TABLES):
        op.drop_table(table)
