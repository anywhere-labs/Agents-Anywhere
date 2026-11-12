"""Keep a summary of each session's newest timeline row on the session.

Session lists (the dashboard snapshot, ``/sessions/list`` and the paginated
``/sessions``) sorted by the newest timeline row and showed its time. They
looked that row up in ``timeline_items`` for every listed session and parsed
its ``payload_json``, so every list read cost one random lookup into the
largest table per session, and the dashboard rebuilds that list on every
change.

Timeline writes now keep the newest row's identity, time, ``order_seq``,
``updated_seq`` and display time on ``sessions`` in the same transaction, and
lists read only those columns. This revision adds the columns and fills them
from the rows already stored, with the same order and the same display time
rule as the read path it replaces.

The backfill reads one newest row per session through
``idx_timeline_items_session_latest`` and parses that row's payload, so its
cost grows with the number of sessions, not with the size of
``timeline_items``. Run it in a maintenance window with workers stopped: a
timeline write that commits while it runs would not be reflected until that
session is written again.

Revision ID: v2_54
Revises: v2_53
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_54"
down_revision = "v2_53"
branch_labels = None
depends_on = None

COLUMNS = (
    ("latest_item_id", sa.Text()),
    ("latest_item_time", sa.Text()),
    ("latest_item_order_seq", sa.Integer()),
    ("latest_item_updated_seq", sa.BigInteger()),
    ("latest_item_at", sa.Text()),
)

BACKFILL = """
UPDATE sessions AS s
SET (
    latest_item_id,
    latest_item_time,
    latest_item_order_seq,
    latest_item_updated_seq,
    latest_item_at
) = (
    SELECT
        t.id,
        t.item_time,
        t.order_seq,
        t.updated_seq,
        coalesce(
            nullif(CAST(t.payload_json AS json) ->> 'updatedAt', ''),
            nullif(CAST(t.payload_json AS json) ->> 'completedAt', ''),
            nullif(CAST(t.payload_json AS json) ->> 'createdAt', '')
        )
    FROM timeline_items AS t
    WHERE t.session_id = s.id
    ORDER BY coalesce(t.item_time, '') DESC, t.order_seq DESC, t.updated_seq DESC
    LIMIT 1
)
WHERE EXISTS (SELECT 1 FROM timeline_items AS e WHERE e.session_id = s.id)
"""


def upgrade() -> None:
    existing = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")
    }
    for name, column_type in COLUMNS:
        if name not in existing:
            op.add_column("sessions", sa.Column(name, column_type))
    op.get_bind().execute(sa.text(BACKFILL))


def downgrade() -> None:
    for name, _ in reversed(COLUMNS):
        op.drop_column("sessions", name)
