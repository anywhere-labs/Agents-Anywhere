"""Require connector sessions to resolve to a project workspace.

Revision ID: v2_27
Revises: v2_26
"""

from __future__ import annotations

import posixpath
import secrets
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import PurePosixPath, PureWindowsPath

import sqlalchemy as sa
from alembic import op


revision: str = "v2_27"
down_revision: str | None = "v2_26"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PROJECT_FOREIGN_KEY = "fk_sessions_project_id_projects"


def _clean_workspace_path(path: str, device_os: str | None) -> tuple[str, str]:
    cleaned = path.strip()
    if not cleaned:
        raise ValueError("workspace path is empty")
    looks_windows = device_os == "windows" or (
        len(cleaned) >= 3 and cleaned[1] == ":" and cleaned[2] in ("/", "\\")
    ) or cleaned.startswith("\\\\")
    if looks_windows:
        value = PureWindowsPath(cleaned)
        if not value.is_absolute():
            raise ValueError("workspace path is not absolute")
        display = str(value)
        return display, value.as_posix().casefold()
    value = PurePosixPath(cleaned)
    if not value.is_absolute():
        raise ValueError("workspace path is not absolute")
    display = posixpath.normpath(cleaned)
    return display, display


def _workspace_name(path: str, device_os: str | None) -> str:
    windows = device_os == "windows" or (
        len(path) >= 3 and path[1] == ":" and path[2] in ("/", "\\")
    ) or path.startswith("\\\\")
    name = PureWindowsPath(path).name if windows else PurePosixPath(path).name
    return name or "Workspace"


def _next_project_name(base: str, names: set[str]) -> str:
    candidate = base
    suffix = 1
    while candidate in names:
        candidate = f"{base} ({suffix})"
        suffix += 1
    return candidate


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _project_foreign_key() -> dict | None:
    inspector = sa.inspect(op.get_bind())
    for foreign_key in inspector.get_foreign_keys("sessions"):
        if foreign_key.get("referred_table") == "projects":
            return foreign_key
    return None


def _delete_session(bind, session_id: str) -> None:
    # All current session-owned tables use ON DELETE CASCADE.  Explicitly
    # remove rows as well so this remains safe on legacy SQLite databases whose
    # foreign_keys pragma was disabled when they were created.
    for table in ("session_active_runs", "timeline_items", "session_shares"):
        if table in sa.inspect(bind).get_table_names():
            bind.execute(
                sa.text(f"DELETE FROM {table} WHERE session_id = :session_id"),
                {"session_id": session_id},
            )
    bind.execute(
        sa.text("DELETE FROM sessions WHERE id = :session_id"),
        {"session_id": session_id},
    )


def _backfill_projects() -> None:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT s.id, s.connector_id, s.project_id, s.cwd, s.created_at, "
            "c.user_id, c.device_os "
            "FROM sessions AS s "
            "JOIN connectors AS c ON c.id = s.connector_id "
            "WHERE s.project_id IS NULL "
            "ORDER BY s.created_at ASC, s.id ASC"
        )
    ).mappings().all()
    names_by_user: dict[str, set[str]] = {}
    for row in rows:
        cwd = row["cwd"]
        if not isinstance(cwd, str) or not cwd.strip():
            _delete_session(bind, str(row["id"]))
            continue
        try:
            workspace_path, workspace_key = _clean_workspace_path(
                cwd,
                row["device_os"],
            )
        except ValueError:
            _delete_session(bind, str(row["id"]))
            continue

        existing = bind.execute(
            sa.text(
                "SELECT id FROM projects "
                "WHERE user_id = :user_id AND connector_id = :connector_id "
                "AND workspace_key = :workspace_key "
                "ORDER BY created_at ASC, id ASC LIMIT 1"
            ),
            {
                "user_id": row["user_id"],
                "connector_id": row["connector_id"],
                "workspace_key": workspace_key,
            },
        ).first()
        if existing is None:
            names = names_by_user.setdefault(str(row["user_id"]), set())
            if not names:
                names.update(
                    value[0]
                    for value in bind.execute(
                        sa.text("SELECT name FROM projects WHERE user_id = :user_id"),
                        {"user_id": row["user_id"]},
                    ).all()
                )
            name = _next_project_name(
                _workspace_name(workspace_path, row["device_os"]),
                names,
            )
            project_id = f"proj_{secrets.token_urlsafe(10)}"
            timestamp = row["created_at"] or _now()
            bind.execute(
                sa.text(
                    "INSERT INTO projects "
                    "(id, user_id, connector_id, name, workspace_path, workspace_key, "
                    "pinned, created_at, updated_at) "
                    "VALUES (:id, :user_id, :connector_id, :name, :workspace_path, "
                    ":workspace_key, 0, :created_at, :updated_at)"
                ),
                {
                    "id": project_id,
                    "user_id": row["user_id"],
                    "connector_id": row["connector_id"],
                    "name": name,
                    "workspace_path": workspace_path,
                    "workspace_key": workspace_key,
                    "created_at": timestamp,
                    "updated_at": timestamp,
                },
            )
            names.add(name)
        else:
            project_id = str(existing[0])
        bind.execute(
            sa.text(
                "UPDATE sessions SET project_id = :project_id, cwd = :cwd "
                "WHERE id = :session_id"
            ),
            {
                "project_id": project_id,
                "cwd": workspace_path,
                "session_id": row["id"],
            },
        )


def _set_project_foreign_key(ondelete: str) -> None:
    foreign_key = _project_foreign_key()
    current = (foreign_key or {}).get("options", {}).get("ondelete")
    if foreign_key is None or str(current).upper() == ondelete:
        return
    with op.batch_alter_table("sessions") as batch_op:
        batch_op.drop_constraint(
            foreign_key.get("name") or _PROJECT_FOREIGN_KEY,
            type_="foreignkey",
        )
        batch_op.create_foreign_key(
            _PROJECT_FOREIGN_KEY,
            "projects",
            ["project_id"],
            ["id"],
            ondelete=ondelete,
        )


def upgrade() -> None:
    _backfill_projects()
    _set_project_foreign_key("RESTRICT")


def downgrade() -> None:
    _set_project_foreign_key("SET NULL")
