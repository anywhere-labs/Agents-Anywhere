"""Index the per-session timeline order head.

`_max_timeline_order_seq` runs `SELECT MAX(order_seq) WHERE session_id = ?` on
lane seeding, cross-instance refresh and incremental sync. Without a
`(session_id, order_seq)` index every call scans all rows of that session, so a
long conversation gets progressively slower.

Revision ID: v2_34
Revises: v2_33
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_34"
down_revision = "v2_33"
branch_labels = None
depends_on = None


def upgrade() -> None:
    indexes = {
        index["name"]
        for index in sa.inspect(op.get_bind()).get_indexes("timeline_items")
    }
    if "idx_timeline_items_session_order_seq" not in indexes:
        op.create_index(
            "idx_timeline_items_session_order_seq",
            "timeline_items",
            ["session_id", "order_seq"],
        )


def downgrade() -> None:
    op.drop_index(
        "idx_timeline_items_session_order_seq",
        table_name="timeline_items",
    )
