"""Fence old runtime notifications after configuration deletion.

Revision ID: v2_36
Revises: v2_35
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_36"
down_revision = "v2_35"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("device_runtimes")
    }
    if "ingress_epoch" not in columns:
        op.add_column(
            "device_runtimes",
            sa.Column(
                "ingress_epoch", sa.Integer(), nullable=False, server_default="0"
            ),
        )


def downgrade() -> None:
    op.drop_column("device_runtimes", "ingress_epoch")
