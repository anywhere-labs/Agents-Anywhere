"""Add durable runtime session state projection.

Revision ID: v2_5
Revises: v2_4
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "v2_5"
down_revision: str | None = "v2_4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if "session_states" not in set(sa.inspect(bind).get_table_names()):
        op.create_table(
            "session_states",
            sa.Column(
                "session_id",
                sa.Text(),
                sa.ForeignKey("sessions.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("runtime", sa.Text(), nullable=False),
            sa.Column("external_session_id", sa.Text(), nullable=True),
            sa.Column("status", sa.Text(), nullable=False),
            sa.Column("selections_json", sa.Text(), nullable=False),
            sa.Column("status_reason", sa.Text(), nullable=True),
            sa.Column("error_json", sa.Text(), nullable=True),
            sa.Column("metadata_json", sa.Text(), nullable=False),
            sa.Column("updated_seq", sa.Integer(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )
    sessions = bind.execute(
        sa.text(
            "SELECT id, runtime, external_session_id, status, model_selection_id, "
            "permission_selection_id, updated_seq, created_at, updated_at FROM sessions"
        )
    ).mappings()
    for session in sessions:
        existing = bind.execute(
            sa.text("SELECT session_id FROM session_states WHERE session_id = :session_id"),
            {"session_id": session["id"]},
        ).first()
        if existing is not None:
            continue
        selections: dict[str, str] = {}
        if session["model_selection_id"]:
            selections["model"] = str(session["model_selection_id"])
        if session["permission_selection_id"]:
            selections["permission"] = str(session["permission_selection_id"])
        bind.execute(
            sa.text(
                "INSERT INTO session_states "
                "(session_id, runtime, external_session_id, status, selections_json, "
                "status_reason, error_json, metadata_json, updated_seq, created_at, updated_at) "
                "VALUES "
                "(:session_id, :runtime, :external_session_id, :status, :selections_json, "
                ":status_reason, :error_json, :metadata_json, :updated_seq, :created_at, :updated_at)"
            ),
            {
                "session_id": session["id"],
                "runtime": session["runtime"],
                "external_session_id": session["external_session_id"],
                "status": session["status"],
                "selections_json": _json_dumps(selections),
                "status_reason": None,
                "error_json": None,
                "metadata_json": _json_dumps({}),
                "updated_seq": session["updated_seq"] or 0,
                "created_at": session["created_at"],
                "updated_at": session["updated_at"],
            },
        )


def downgrade() -> None:
    op.drop_table("session_states")


def _json_dumps(value: object) -> str:
    import json

    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
