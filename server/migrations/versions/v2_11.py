"""Add DeepSeek Harness agent facts and public Runtime metadata.

Revision ID: v2_11
Revises: v2_10
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_11"
down_revision: str | None = "v2_10"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns(
            "dashboard_user_daily_facts"
        )
    }
    if "dsh_agents" not in columns:
        op.add_column(
            "dashboard_user_daily_facts",
            sa.Column(
                "dsh_agents",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
        )
    runtime_columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("device_runtimes")
    }
    if "inventory_metadata_json" not in runtime_columns:
        op.add_column(
            "device_runtimes",
            sa.Column(
                "inventory_metadata_json",
                sa.Text(),
                nullable=False,
                server_default="{}",
            ),
        )


def downgrade() -> None:
    runtime_columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("device_runtimes")
    }
    if "inventory_metadata_json" in runtime_columns:
        op.drop_column("device_runtimes", "inventory_metadata_json")
    columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns(
            "dashboard_user_daily_facts"
        )
    }
    if "dsh_agents" in columns:
        op.drop_column("dashboard_user_daily_facts", "dsh_agents")
