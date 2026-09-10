"""Store protocol clock revisions as 64-bit integers.

Revision ID: v2_4
Revises: v2_3
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_4"
down_revision: str | None = "v2_3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PROTOCOL_REVISION_TABLES = (
    "connector_protocol_capabilities",
    "connector_runtime_catalogs",
)


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        # SQLite INTEGER values are already signed 64-bit values.
        return
    for table_name in _PROTOCOL_REVISION_TABLES:
        op.alter_column(
            table_name,
            "revision",
            existing_type=sa.Integer(),
            type_=sa.BigInteger(),
            existing_nullable=False,
        )


def downgrade() -> None:
    raise RuntimeError("downgrading v2.4 could overflow protocol revisions")
