"""Remove application release checksums.

Revision ID: v2_17
Revises: v2_16
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "v2_17"
down_revision: str | None = "v2_16"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("app_releases")}
    if "sha256" in columns:
        op.drop_column("app_releases", "sha256")


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("app_releases")}
    if "sha256" not in columns:
        op.add_column("app_releases", sa.Column("sha256", sa.Text()))
