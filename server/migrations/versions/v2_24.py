"""Distinguish Desktop-managed connectors from CLI connectors.

Revision ID: v2_24
Revises: v2_23
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_24"
down_revision: str | None = "v2_23"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("connectors")
    }
    if "connector_kind" not in columns:
        op.add_column(
            "connectors",
            sa.Column(
                "connector_kind",
                sa.Text(),
                nullable=False,
                server_default="cli",
            ),
        )


def downgrade() -> None:
    columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("connectors")
    }
    if "connector_kind" in columns:
        op.drop_column("connectors", "connector_kind")
