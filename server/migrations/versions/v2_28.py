"""Allow multiple projects to use the same workspace.

Revision ID: v2_28
Revises: v2_27
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "v2_28"
down_revision: str | None = "v2_27"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_WORKSPACE_UNIQUE_CONSTRAINT = "uq_projects_user_connector_workspace"


def _unique_constraint_names() -> set[str]:
    inspector = sa.inspect(op.get_bind())
    if "projects" not in inspector.get_table_names():
        return set()
    return {
        constraint["name"]
        for constraint in inspector.get_unique_constraints("projects")
    }


def upgrade() -> None:
    if _WORKSPACE_UNIQUE_CONSTRAINT not in _unique_constraint_names():
        return
    op.drop_constraint(_WORKSPACE_UNIQUE_CONSTRAINT, "projects", type_="unique")


def downgrade() -> None:
    if _WORKSPACE_UNIQUE_CONSTRAINT in _unique_constraint_names():
        return
    duplicate = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT 1 FROM projects "
                "GROUP BY user_id, connector_id, workspace_key "
                "HAVING COUNT(*) > 1 LIMIT 1"
            )
        )
        .first()
    )
    if duplicate is not None:
        raise RuntimeError(
            "cannot downgrade v2_28 while multiple projects share a workspace"
        )
    op.create_unique_constraint(
        _WORKSPACE_UNIQUE_CONSTRAINT,
        "projects",
        ["user_id", "connector_id", "workspace_key"],
    )
