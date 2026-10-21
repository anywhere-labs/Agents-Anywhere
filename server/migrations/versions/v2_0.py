"""Create the v2.0 schema.

Revision ID: v2_0
Revises:
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

from migrations.schema_v2_0 import metadata

revision: str = "v2_0"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    raise RuntimeError("downgrading below the v2.0 schema is not supported")
