"""Store the user's manual sidebar order.

The web sidebar used to order projects and sessions by activity, so rows kept
jumping while several sessions ran. It now follows an order the user drags into
place. Keeping that order in browser storage made it differ per device, so it
lives here: one row per user holding the full project id list and the full
session id list. A drag rewrites the affected list as a whole; ids the list
has not seen yet are shown first by creation time, so nothing needs to be
written until the user actually drags.

Revision ID: v2_39
Revises: v2_38
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_39"
down_revision = "v2_38"
branch_labels = None
depends_on = None

TABLE = "user_sidebar_orders"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    if TABLE in _table_names():
        return
    op.create_table(
        TABLE,
        sa.Column(
            "user_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("projects_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("sessions_json", sa.Text(), nullable=False, server_default="[]"),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("user_id"),
    )


def downgrade() -> None:
    if TABLE in _table_names():
        op.drop_table(TABLE)
