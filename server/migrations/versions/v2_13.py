"""Mark DSH archives inherited from the pre-source-state sync path.

Revision ID: v2_13
Revises: v2_12
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_13"
down_revision: str | None = "v2_12"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")
    }
    if "dsh_archive_legacy" not in columns:
        op.add_column(
            "sessions",
            sa.Column(
                "dsh_archive_legacy",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
        )
    op.execute(
        sa.text(
            "UPDATE sessions SET dsh_archive_legacy = 1 "
            "WHERE runtime = 'dsh' AND archived = 1"
        )
    )


def downgrade() -> None:
    columns = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")
    }
    if "dsh_archive_legacy" in columns:
        op.drop_column("sessions", "dsh_archive_legacy")
