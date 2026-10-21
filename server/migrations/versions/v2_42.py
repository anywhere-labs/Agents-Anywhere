"""Replace the recomputed admin dashboard with event-driven usage statistics.

The old dashboard rebuilt `dashboard_daily_metrics` and
`dashboard_user_daily_facts` from raw timeline rows on every request and
tracked user activity in `platform_user_activity` from a handful of endpoints.
Usage is now appended to `usage_events` as it happens and daily stock metrics
are captured in `usage_inventory_snapshots`. History is not backfilled: the
new report starts on the day this revision is applied.

Revision ID: v2_42
Revises: v2_41
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_42"
down_revision = "v2_41"
branch_labels = None
depends_on = None

DROPPED_TABLES = (
    "dashboard_user_daily_facts",
    "dashboard_daily_metrics",
    "dashboard_settings",
    "platform_user_activity",
)


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    tables = _table_names()
    if "usage_events" not in tables:
        op.create_table(
            "usage_events",
            sa.Column("id", sa.Text(), nullable=False),
            sa.Column("occurred_at", sa.Text(), nullable=False),
            sa.Column("hour_bucket", sa.Text(), nullable=False),
            sa.Column("event_type", sa.Text(), nullable=False),
            sa.Column(
                "user_id",
                sa.Text(),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
            ),
            sa.Column("connector_id", sa.Text()),
            sa.Column("session_id", sa.Text()),
            sa.Column("runtime_type", sa.Text()),
            sa.Column("runtime_id", sa.Text()),
            sa.Column("device_os", sa.Text()),
            sa.Column("outcome", sa.Text()),
            sa.Column("duration_ms", sa.Integer()),
            sa.Column("dedupe_key", sa.Text()),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("dedupe_key", name="uq_usage_events_dedupe_key"),
        )
        op.create_index("idx_usage_events_hour", "usage_events", ["hour_bucket"])
        op.create_index(
            "idx_usage_events_type_hour", "usage_events", ["event_type", "hour_bucket"]
        )
        op.create_index(
            "idx_usage_events_session_time", "usage_events", ["session_id", "occurred_at"]
        )
        op.create_index(
            "idx_usage_events_user_hour", "usage_events", ["user_id", "hour_bucket"]
        )
    if "usage_inventory_snapshots" not in tables:
        op.create_table(
            "usage_inventory_snapshots",
            sa.Column("snapshot_date", sa.Text(), nullable=False),
            sa.Column("metric_key", sa.Text(), nullable=False),
            sa.Column("dimension", sa.Text(), nullable=False, server_default=""),
            sa.Column("value", sa.Float(), nullable=False),
            sa.Column("computed_at", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("snapshot_date", "metric_key", "dimension"),
        )
    for table in DROPPED_TABLES:
        if table in tables:
            op.drop_table(table)


def downgrade() -> None:
    tables = _table_names()
    if "usage_inventory_snapshots" in tables:
        op.drop_table("usage_inventory_snapshots")
    if "usage_events" in tables:
        op.drop_table("usage_events")
    if "platform_user_activity" not in tables:
        op.create_table(
            "platform_user_activity",
            sa.Column(
                "user_id",
                sa.Text(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("activity_date", sa.Text(), nullable=False),
            sa.Column("first_seen_at", sa.Text(), nullable=False),
            sa.Column("last_seen_at", sa.Text(), nullable=False),
            sa.Column("event_count", sa.Integer(), nullable=False, server_default="0"),
            sa.PrimaryKeyConstraint("user_id", "activity_date"),
        )
        op.create_index(
            "idx_platform_user_activity_last_seen",
            "platform_user_activity",
            ["last_seen_at"],
        )
    if "dashboard_daily_metrics" not in tables:
        op.create_table(
            "dashboard_daily_metrics",
            sa.Column("date", sa.Text(), nullable=False),
            sa.Column("metric_key", sa.Text(), nullable=False),
            sa.Column("dimension_key", sa.Text(), nullable=False, server_default=""),
            sa.Column("dimension_value", sa.Text(), nullable=False, server_default=""),
            sa.Column("value", sa.Float(), nullable=False),
            sa.Column("computed_at", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("date", "metric_key", "dimension_key", "dimension_value"),
        )
        op.create_index(
            "idx_dashboard_daily_metrics_date", "dashboard_daily_metrics", ["date"]
        )
    if "dashboard_user_daily_facts" not in tables:
        op.create_table(
            "dashboard_user_daily_facts",
            sa.Column("date", sa.Text(), nullable=False),
            sa.Column(
                "user_id",
                sa.Text(),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("messages", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("active_sessions", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_sessions", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("devices", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("macos_devices", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("windows_devices", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("linux_devices", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("unknown_devices", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("codex_agents", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("claude_agents", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("dsh_agents", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("last_activity_at", sa.Text()),
            sa.Column("computed_at", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("date", "user_id"),
        )
        op.create_index(
            "idx_dashboard_user_daily_facts_user_date",
            "dashboard_user_daily_facts",
            ["user_id", "date"],
        )
    if "dashboard_settings" not in tables:
        op.create_table(
            "dashboard_settings",
            sa.Column("key", sa.Text(), nullable=False),
            sa.Column("value_json", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.PrimaryKeyConstraint("key"),
        )
