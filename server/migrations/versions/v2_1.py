"""Fence Connector presence updates across Server instances.

Revision ID: v2_1
Revises: v2_0
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_1"
down_revision: str | None = "v2_0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "connectors",
        sa.Column("presence_instance_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "connectors",
        sa.Column("presence_connection_id", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    raise RuntimeError(
        "downgrading the v2.1 Connector presence schema is not supported"
    )
