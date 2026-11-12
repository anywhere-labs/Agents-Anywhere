"""Align timeline and connector indexes with production.

``idx_timeline_items_item_time_type_role`` leads with ``item_time`` and is not
used by any query since 2.1.0: every timeline read is scoped by ``session_id``
and served by the per-session indexes. On production it had grown to ~79 GB and
was dropped by hand, so this revision drops it everywhere else too.

Connector lookups filter on ``user_id`` and ``revoked = 0``. Production gained
``idx_connectors_user_revoked`` by hand; this revision creates it elsewhere.

Both statements are guarded with ``IF EXISTS`` / ``IF NOT EXISTS`` so the
revision is a no-op on databases that were already aligned by hand. They run
without ``CONCURRENTLY``: the whole upgrade shares one transaction, and the
revision is meant to run in a maintenance window with workers stopped, where
dropping an index and indexing the small ``connectors`` table are quick.

Revision ID: v2_48
Revises: v2_47
"""

from alembic import op

revision = "v2_48"
down_revision = "v2_47"
branch_labels = None
depends_on = None

TIMELINE_INDEX = "idx_timeline_items_item_time_type_role"
CONNECTOR_INDEX = "idx_connectors_user_revoked"


def upgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {TIMELINE_INDEX}")
    op.execute(
        f"CREATE INDEX IF NOT EXISTS {CONNECTOR_INDEX} "
        "ON connectors (user_id, revoked)"
    )


def downgrade() -> None:
    op.execute(f"DROP INDEX IF EXISTS {CONNECTOR_INDEX}")
    # Rebuilding this index scans the whole timeline table and can take a long
    # time on large databases.
    op.execute(
        f"CREATE INDEX IF NOT EXISTS {TIMELINE_INDEX} "
        "ON timeline_items (item_time, type, role)"
    )
