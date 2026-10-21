"""Remove the stored manual sidebar order.

v2_39 stored a per-user drag order for sidebar projects and sessions. The
sidebar goes back to ordering by activity, so the table is dropped.

Revision ID: v2_41
Revises: v2_40
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_41"
down_revision = "v2_40"
branch_labels = None
depends_on = None

TABLE = "user_sidebar_orders"


def _table_names() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    if TABLE in _table_names():
        op.drop_table(TABLE)


def downgrade() -> None:
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
