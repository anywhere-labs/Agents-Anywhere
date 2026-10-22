"""Persist authoritative native workspace memberships.

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
    # Unversioned databases adopted through metadata.create_all may already
    # contain this table while older columns elsewhere still need migration.
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("runtime_workspace_inventories"):
        columns = {
            column["name"]
            for column in inspector.get_columns("runtime_workspace_inventories")
        }
        primary_key = set(
            inspector.get_pk_constraint("runtime_workspace_inventories")[
                "constrained_columns"
            ]
        )
        if columns != {
            "connector_id",
            "runtime_id",
            "snapshot_id",
            "observed_at",
            "snapshot_json",
        } or primary_key != {"connector_id", "runtime_id"}:
            raise RuntimeError(
                "existing runtime workspace inventory table has an incompatible schema"
            )
        return
    op.create_table(
        "runtime_workspace_inventories",
        sa.Column(
            "connector_id",
            sa.Text(),
            sa.ForeignKey("connectors.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("runtime_id", sa.Text(), primary_key=True),
        sa.Column("snapshot_id", sa.Text(), nullable=False),
        sa.Column("observed_at", sa.Text(), nullable=False),
        sa.Column("snapshot_json", sa.Text(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("runtime_workspace_inventories")
