"""Persist native workspace identities and definitive source archive observations."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_33"
down_revision: str | None = "v2_32"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "runtime_workspaces",
        sa.Column(
            "connector_id",
            sa.Text(),
            sa.ForeignKey("connectors.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("runtime_id", sa.Text(), nullable=False),
        sa.Column("external_id", sa.Text(), nullable=False),
        sa.Column(
            "project_id",
            sa.Text(),
            sa.ForeignKey("projects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("source_name", sa.Text(), nullable=False),
        sa.Column("assigned_name", sa.Text(), nullable=False),
        sa.Column(
            "created_project", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.PrimaryKeyConstraint("connector_id", "runtime_id", "external_id"),
        if_not_exists=True,
    )
    op.create_table(
        "runtime_workspace_sessions",
        sa.Column("connector_id", sa.Text(), nullable=False),
        sa.Column("runtime_id", sa.Text(), nullable=False),
        sa.Column("session_id", sa.Text(), nullable=False),
        sa.Column("workspace_id", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("connector_id", "runtime_id", "session_id"),
        sa.ForeignKeyConstraint(
            ["connector_id", "runtime_id", "workspace_id"],
            [
                "runtime_workspaces.connector_id",
                "runtime_workspaces.runtime_id",
                "runtime_workspaces.external_id",
            ],
            ondelete="CASCADE",
        ),
        if_not_exists=True,
    )
    if "source_archive_latched" not in {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns("sessions")
    }:
        op.add_column(
            "sessions",
            sa.Column(
                "source_archive_latched",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )
    op.execute(
        sa.text(
            "UPDATE sessions SET source_archive_latched = true WHERE source_state = 'archived'"
        )
    )


def downgrade() -> None:
    op.drop_column("sessions", "source_archive_latched")
    op.drop_table("runtime_workspace_sessions")
    op.drop_table("runtime_workspaces")
