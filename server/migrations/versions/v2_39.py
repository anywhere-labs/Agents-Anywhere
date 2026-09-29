"""Report OpenCode installs in the admin dashboard agent facts.

OpenCode ships as a first-class runtime alongside Codex, Claude Code and DSH, so
the dashboard agent breakdown and the per-user daily facts gain an
``opencode_agents`` counter next to ``codex_agents`` and the rest.

Revision ID: v2_39
Revises: v2_38
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_39"
down_revision: str | None = "v2_38"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns(
            "dashboard_user_daily_facts"
        )
    }
    if "opencode_agents" not in columns:
        op.add_column(
            "dashboard_user_daily_facts",
            sa.Column(
                "opencode_agents",
                sa.Integer(),
                nullable=False,
                server_default="0",
            ),
        )


def downgrade() -> None:
    columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns(
            "dashboard_user_daily_facts"
        )
    }
    if "opencode_agents" in columns:
        op.drop_column("dashboard_user_daily_facts", "opencode_agents")
