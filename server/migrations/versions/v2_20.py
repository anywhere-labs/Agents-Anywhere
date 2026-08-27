"""Generalize runtime session source state observations.

Revision ID: v2_20
Revises: v2_19
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "v2_20"
down_revision: str | None = "v2_19"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")}
    if "source_state_reason" not in columns:
        op.add_column("sessions", sa.Column("source_state_reason", sa.Text()))
    if "source_observation_origin" not in columns:
        op.add_column("sessions", sa.Column("source_observation_origin", sa.Text()))


def downgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")}
    if "source_observation_origin" in columns:
        op.drop_column("sessions", "source_observation_origin")
    if "source_state_reason" in columns:
        op.drop_column("sessions", "source_state_reason")
