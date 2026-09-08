"""Remove the obsolete Runtime Control negotiation state.

Revision ID: v2_33
Revises: v2_32
"""

import sqlalchemy as sa
from alembic import op

revision = "v2_33"
down_revision = "v2_32"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("connectors", "runtime_control_version")


def downgrade() -> None:
    op.add_column(
        "connectors",
        sa.Column("runtime_control_version", sa.Text(), nullable=False, server_default="1.0"),
    )
