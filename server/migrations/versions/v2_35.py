"""Index the per-session newest timeline row.

Session lists join the newest timeline row of every returned session. The old
query shape ranked the whole ``timeline_items`` table with ``row_number()``,
which a session predicate cannot be pushed into, so every list read (and every
``dashboard.changed`` refresh) scanned and sorted every timeline row in the
database.

Reading one newest row per session orders by
``(coalesce(item_time, ''), order_seq, updated_seq)``. The existing
``(session_id, item_time)`` index only covers the first key, and a single
``item_time`` value is shared by up to ~1300 rows, so the lookup still had to
sort those rows. This revision replaces that index with the full ordering key,
which turns the per-session lookup into a single index scan with no sort.

The index uses the ``coalesce(item_time, '')`` expression rather than
``item_time DESC NULLS LAST`` because SQLite rejects ``NULLS LAST`` in index
definitions.

Revision ID: v2_35
Revises: v2_34
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_35"
down_revision = "v2_34"
branch_labels = None
depends_on = None

LEGACY_INDEX = "idx_timeline_items_session_item_time"
LATEST_INDEX = "idx_timeline_items_session_latest"


def _index_exists(name: str) -> bool:
    """Check index existence including expression-based indexes.

    ``Inspector.get_indexes`` skips expression-based indexes, so it cannot see
    the index this revision creates.
    """

    bind = op.get_bind()
    if bind.dialect.name == "sqlite":
        statement = sa.text(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = :name"
        )
    else:
        statement = sa.text("SELECT 1 FROM pg_indexes WHERE indexname = :name")
    return bind.execute(statement, {"name": name}).first() is not None


def upgrade() -> None:
    if not _index_exists(LATEST_INDEX):
        op.create_index(
            LATEST_INDEX,
            "timeline_items",
            [
                sa.text("session_id"),
                sa.text("coalesce(item_time, '') DESC"),
                sa.text("order_seq DESC"),
                sa.text("updated_seq DESC"),
            ],
        )
    if _index_exists(LEGACY_INDEX):
        op.drop_index(LEGACY_INDEX, table_name="timeline_items")


def downgrade() -> None:
    if not _index_exists(LEGACY_INDEX):
        op.create_index(
            LEGACY_INDEX,
            "timeline_items",
            ["session_id", "item_time"],
        )
    if _index_exists(LATEST_INDEX):
        op.drop_index(LATEST_INDEX, table_name="timeline_items")
