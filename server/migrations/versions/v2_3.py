"""Make Interaction notices authoritative and remove archived legacy storage.

Revision ID: v2_3
Revises: v2_2
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op

revision: str = "v2_3"
down_revision: str | None = "v2_2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_LEGACY_TABLES = (
    "agent_efforts",
    "agent_models",
    "agent_modes",
    "device_agent_settings",
    "user_agent_defaults",
)


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "approvals" in tables:
        _migrate_approvals_to_notices(bind)
        op.drop_table("approvals")
    for table_name in _LEGACY_TABLES:
        if table_name in tables:
            op.drop_table(table_name)
    if "runtime_capabilities" in _column_names(bind, "connectors"):
        op.drop_column("connectors", "runtime_capabilities")
    if "runtime_settings_override" in _column_names(bind, "sessions"):
        op.drop_column("sessions", "runtime_settings_override")


def downgrade() -> None:
    raise RuntimeError(
        "downgrading v2.3 would restore superseded Approval and legacy storage"
    )


def _migrate_approvals_to_notices(bind) -> None:
    tables = set(sa.inspect(bind).get_table_names())
    if "notices" not in tables:
        raise RuntimeError("v2.3 requires the notices table")
    approvals = bind.execute(sa.text("SELECT * FROM approvals")).mappings()
    for approval in approvals:
        values = _approval_notice_values(dict(approval))
        existing = (
            bind.execute(
                sa.text("SELECT source_json, context_json FROM notices WHERE id = :id"),
                {"id": values["id"]},
            )
            .mappings()
            .first()
        )
        if existing is None:
            bind.execute(
                sa.text(
                    "INSERT INTO notices "
                    "(id, session_id, type, status, interaction_type, blocking_json, "
                    "response_required, severity, title, message, source_json, actions_json, "
                    "context_json, metadata_json, revision, updated_seq, created_at, updated_at, "
                    "expires_at, resolved_at) VALUES "
                    "(:id, :session_id, :type, :status, :interaction_type, :blocking_json, "
                    ":response_required, :severity, :title, :message, :source_json, :actions_json, "
                    ":context_json, :metadata_json, :revision, :updated_seq, :created_at, :updated_at, "
                    ":expires_at, :resolved_at)"
                ),
                values,
            )
            continue
        source = {
            **_load_object(existing["source_json"]),
            **_load_object(values["source_json"]),
        }
        context = {
            **_load_object(existing["context_json"]),
            **_load_object(values["context_json"]),
        }
        bind.execute(
            sa.text(
                "UPDATE notices SET source_json = :source_json, context_json = :context_json "
                "WHERE id = :id"
            ),
            {
                "id": values["id"],
                "source_json": _dump_json(source),
                "context_json": _dump_json(context),
            },
        )


def _approval_notice_values(approval: dict[str, Any]) -> dict[str, Any]:
    approval_id = str(approval["id"])
    session_id = str(approval["session_id"])
    approval_status = str(approval["status"])
    source = _load_object(approval.get("source_json"))
    choices = _load_list(approval.get("choices_json"))
    resolved_at = approval.get("resolved_at")
    created_at = str(approval["created_at"])
    return {
        "id": _approval_notice_id(approval_id),
        "session_id": session_id,
        "type": "interaction",
        "status": _notice_status(approval_status),
        "interaction_type": "approval",
        "blocking_json": _dump_json({"scope": "session", "targetId": session_id}),
        "response_required": 1,
        "severity": "warning",
        "title": str(approval["title"]),
        "message": approval.get("description"),
        "source_json": _dump_json(
            {
                "runtime": source.get("runtime"),
                "approvalId": approval_id,
                "timelineItemId": approval.get("target_item_id"),
            }
        ),
        "actions_json": _dump_json(_approval_actions(choices)),
        "context_json": _dump_json(
            {
                "approvalId": approval_id,
                "approvalStatus": approval_status,
                "approvalSource": source,
                "turnId": approval.get("turn_id"),
                "targetItemId": approval.get("target_item_id"),
                "kind": approval.get("kind") or "unknown",
                "payload": _load_json(approval.get("payload_json"), {}),
                "choices": choices,
            }
        ),
        "metadata_json": "{}",
        "revision": 1,
        "updated_seq": int(approval["updated_seq"]),
        "created_at": created_at,
        "updated_at": str(resolved_at or created_at),
        "expires_at": None,
        "resolved_at": resolved_at,
    }


def _approval_notice_id(approval_id: str) -> str:
    digest = hashlib.sha256(
        json.dumps(
            (approval_id,),
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        ).encode("utf-8")
    ).hexdigest()[:24]
    return f"notice_approval_{digest}"


def _notice_status(approval_status: str) -> str:
    if approval_status == "pending":
        return "open"
    if approval_status == "expired":
        return "expired"
    if approval_status == "cancelled":
        return "cancelled"
    return "resolved"


def _approval_actions(choices: list[Any]) -> list[dict[str, Any]]:
    actions = {
        "approve": {
            "actionId": "approve",
            "label": "Approve",
            "style": "primary",
            "input": {"required": False},
        },
        "approve_for_session": {
            "actionId": "approve_for_session",
            "label": "Approve for session",
            "style": "secondary",
            "input": {"required": False},
        },
        "reject": {
            "actionId": "reject",
            "label": "Reject",
            "style": "danger",
            "input": {"required": False},
        },
        "cancel": {
            "actionId": "cancel",
            "label": "Cancel",
            "style": "secondary",
            "input": {"required": False},
        },
    }
    return [actions[choice] for choice in choices if choice in actions]


def _column_names(bind, table: str) -> set[str]:
    inspector = sa.inspect(bind)
    if table not in inspector.get_table_names():
        return set()
    return {str(column["name"]) for column in inspector.get_columns(table)}


def _load_json(value: Any, default: Any) -> Any:
    if not isinstance(value, str) or not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _load_object(value: Any) -> dict[str, Any]:
    loaded = _load_json(value, {})
    return loaded if isinstance(loaded, dict) else {}


def _load_list(value: Any) -> list[Any]:
    loaded = _load_json(value, [])
    return loaded if isinstance(loaded, list) else []


def _dump_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
