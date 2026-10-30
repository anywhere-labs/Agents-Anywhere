"""Durable workspace preparation and asynchronous session creation.
Revision ID: v2_45
Revises: v2_44
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_45"
down_revision = "v2_44"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "runtime_workflows",
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("id", sa.Text(), nullable=False),
        sa.Column("connector_id", sa.Text(), nullable=False),
        sa.Column("runtime_id", sa.Text(), nullable=False),
        sa.Column("runtime_type", sa.Text(), nullable=False),
        sa.Column("project_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text()),
        sa.Column("input_digest", sa.Text(), nullable=False),
        sa.Column("request_json", sa.Text(), nullable=False),
        sa.Column("result_json", sa.Text(), nullable=False),
        sa.Column("consumed_by", sa.Text()),
        sa.PrimaryKeyConstraint("user_id", "kind", "id"),
        sa.ForeignKeyConstraint(
            ["connector_id"], ["connectors.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
    )

    op.create_table(
        "session_runtime_event_receipts",
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("source_event_id", sa.Text(), nullable=False),
        sa.Column("event_digest", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("session_id", "source_event_id"),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
    )


def downgrade() -> None:
    op.drop_table("session_runtime_event_receipts")
    op.drop_table("runtime_workflows")
