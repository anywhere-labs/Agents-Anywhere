"""Track who owns a session title so connector syncs cannot overwrite renames.

Revision ID: v2_37
Revises: v2_36
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_37"
down_revision: str | None = "v2_36"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")}
    if "title_source" not in columns:
        op.add_column("sessions", sa.Column("title_source", sa.Text()))


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")}
    if "title_source" in columns:
        op.drop_column("sessions", "title_source")
