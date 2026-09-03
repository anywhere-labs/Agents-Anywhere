"""Restore unique project workspaces and project names.

Revision ID: v2_28
Revises: v2_27
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "v2_28"
down_revision: str | None = "v2_27"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_WORKSPACE_UNIQUE_CONSTRAINT = "uq_projects_user_connector_workspace"
_NAME_UNIQUE_CONSTRAINT = "uq_projects_user_name"


def _unique_constraint_names() -> set[str | None]:
    inspector = sa.inspect(op.get_bind())
    if "projects" not in inspector.get_table_names():
        return set()
    return {
        constraint["name"]
        for constraint in inspector.get_unique_constraints("projects")
    }


def _merge_duplicate_workspaces() -> None:
    bind = op.get_bind()
    rows = (
        bind.execute(
            sa.text(
                "SELECT id, user_id, connector_id, workspace_key, pinned, pinned_at, "
                "created_at, updated_at FROM projects "
                "ORDER BY user_id, connector_id, workspace_key, created_at, id"
            )
        )
        .mappings()
        .all()
    )
    groups: dict[tuple[str, str, str], list[dict]] = defaultdict(list)
    for row in rows:
        groups[
            (
                str(row["user_id"]),
                str(row["connector_id"]),
                str(row["workspace_key"]),
            )
        ].append(row)

    for group in groups.values():
        if len(group) < 2:
            continue
        keeper = group[0]
        duplicate_ids = [str(row["id"]) for row in group[1:]]
        pinned_at_values = [
            str(row["pinned_at"]) for row in group if row["pinned_at"] is not None
        ]
        updated_at_values = [str(row["updated_at"]) for row in group]
        bind.execute(
            sa.text(
                "UPDATE projects SET pinned = :pinned, pinned_at = :pinned_at, "
                "updated_at = :updated_at WHERE id = :project_id"
            ),
            {
                "pinned": int(any(bool(row["pinned"]) for row in group)),
                "pinned_at": max(pinned_at_values) if pinned_at_values else None,
                "updated_at": max(updated_at_values),
                "project_id": keeper["id"],
            },
        )
        for duplicate_id in duplicate_ids:
            bind.execute(
                sa.text(
                    "UPDATE sessions SET project_id = :keeper_id "
                    "WHERE project_id = :duplicate_id"
                ),
                {
                    "keeper_id": keeper["id"],
                    "duplicate_id": duplicate_id,
                },
            )
            bind.execute(
                sa.text("DELETE FROM projects WHERE id = :project_id"),
                {"project_id": duplicate_id},
            )


def _next_project_name(base: str, occupied: set[str]) -> str:
    suffix = 1
    while True:
        marker = f" ({suffix})"
        candidate = f"{base[: max(1, 255 - len(marker))]}{marker}"
        if candidate not in occupied:
            return candidate
        suffix += 1


def _deduplicate_project_names() -> None:
    bind = op.get_bind()
    rows = (
        bind.execute(
            sa.text(
                "SELECT id, user_id, name FROM projects "
                "ORDER BY user_id, created_at, id"
            )
        )
        .mappings()
        .all()
    )
    rows_by_user: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        rows_by_user[str(row["user_id"])].append(row)

    for user_rows in rows_by_user.values():
        occupied = {str(row["name"]) for row in user_rows}
        seen: set[str] = set()
        for row in user_rows:
            name = str(row["name"])
            if name not in seen:
                seen.add(name)
                continue
            replacement = _next_project_name(name or "Project", occupied)
            bind.execute(
                sa.text("UPDATE projects SET name = :name WHERE id = :project_id"),
                {"name": replacement, "project_id": row["id"]},
            )
            occupied.add(replacement)
            seen.add(replacement)


def upgrade() -> None:
    _merge_duplicate_workspaces()
    _deduplicate_project_names()
    existing = _unique_constraint_names()
    with op.batch_alter_table("projects") as batch_op:
        if _WORKSPACE_UNIQUE_CONSTRAINT not in existing:
            batch_op.create_unique_constraint(
                _WORKSPACE_UNIQUE_CONSTRAINT,
                ["user_id", "connector_id", "workspace_key"],
            )
        if _NAME_UNIQUE_CONSTRAINT not in existing:
            batch_op.create_unique_constraint(
                _NAME_UNIQUE_CONSTRAINT,
                ["user_id", "name"],
            )


def downgrade() -> None:
    existing = _unique_constraint_names()
    with op.batch_alter_table("projects") as batch_op:
        if _NAME_UNIQUE_CONSTRAINT in existing:
            batch_op.drop_constraint(_NAME_UNIQUE_CONSTRAINT, type_="unique")
        if _WORKSPACE_UNIQUE_CONSTRAINT in existing:
            batch_op.drop_constraint(
                _WORKSPACE_UNIQUE_CONSTRAINT,
                type_="unique",
            )
