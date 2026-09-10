"""Track projects explicitly created by the user.

Revision ID: v2_31
Revises: v2_30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_31"
down_revision: str | None = "v2_30"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("projects")
    }
    if "manually_created" in columns:
        return
    op.add_column(
        "projects",
        sa.Column(
            "manually_created", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )


def downgrade() -> None:
    columns = {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("projects")
    }
    if "manually_created" in columns:
        op.drop_column("projects", "manually_created")
