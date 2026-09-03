"""Add named projects and optional session bindings.

Revision ID: v2_25
Revises: v2_24
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "v2_25"
down_revision: str | None = "v2_24"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "projects" not in inspector.get_table_names():
        op.create_table(
            "projects",
            sa.Column("id", sa.Text(), nullable=False),
            sa.Column("user_id", sa.Text(), nullable=False),
            sa.Column("connector_id", sa.Text(), nullable=False),
            sa.Column("name", sa.Text(), nullable=False),
            sa.Column("workspace_path", sa.Text(), nullable=False),
            sa.Column("workspace_key", sa.Text(), nullable=False),
            sa.Column("pinned", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("pinned_at", sa.Text(), nullable=True),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
            sa.ForeignKeyConstraint(
                ["user_id"],
                ["users.id"],
                ondelete="CASCADE",
            ),
            sa.ForeignKeyConstraint(
                ["connector_id"],
                ["connectors.id"],
                ondelete="CASCADE",
            ),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "user_id",
                "connector_id",
                "workspace_key",
                name="uq_projects_user_connector_workspace",
            ),
        )
        op.create_index(
            "idx_projects_user_pinned_updated",
            "projects",
            ["user_id", "pinned", "pinned_at", "updated_at"],
            unique=False,
        )
        op.create_index(
            "idx_projects_connector_workspace",
            "projects",
            ["connector_id", "workspace_key"],
            unique=False,
        )

    session_columns = {
        column["name"]
        for column in sa.inspect(op.get_bind()).get_columns("sessions")
    }
    if "project_id" not in session_columns:
        with op.batch_alter_table("sessions") as batch_op:
            batch_op.add_column(
                sa.Column("project_id", sa.Text(), nullable=True)
            )
            batch_op.create_foreign_key(
                "fk_sessions_project_id_projects",
                "projects",
                ["project_id"],
                ["id"],
                ondelete="SET NULL",
            )
    session_indexes = {
        index["name"]
        for index in sa.inspect(op.get_bind()).get_indexes("sessions")
    }
    if "idx_sessions_project_archived_sort" not in session_indexes:
        op.create_index(
            "idx_sessions_project_archived_sort",
            "sessions",
            ["project_id", "archived", "pinned", "sort_at"],
            unique=False,
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "sessions" in inspector.get_table_names():
        session_indexes = {
            index["name"] for index in inspector.get_indexes("sessions")
        }
        if "idx_sessions_project_archived_sort" in session_indexes:
            op.drop_index(
                "idx_sessions_project_archived_sort",
                table_name="sessions",
            )
        session_columns = {
            column["name"] for column in inspector.get_columns("sessions")
        }
        if "project_id" in session_columns:
            with op.batch_alter_table("sessions") as batch_op:
                batch_op.drop_constraint(
                    "fk_sessions_project_id_projects",
                    type_="foreignkey",
                )
                batch_op.drop_column("project_id")
    if "projects" in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table("projects")
