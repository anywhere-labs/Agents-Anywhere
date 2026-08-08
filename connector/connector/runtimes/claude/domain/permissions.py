from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimePermissionCatalog,
    RuntimePermissionItem,
)
from connector.server.protocol import protocol_selection_id

CLAUDE_PERMISSION_MODES: tuple[Mapping[str, Any], ...] = (
    {
        "id": "default",
        "title": "Ask permissions",
        "description": "Use Claude Code's default prompts for risky tools.",
        "default": True,
    },
    {
        "id": "acceptEdits",
        "title": "Accept edits",
        "description": "Automatically accept file edits; still ask for other risky tools.",
    },
    {
        "id": "plan",
        "title": "Plan mode",
        "description": "Allow planning without executing writes or commands.",
    },
    {
        "id": "auto",
        "title": "Auto mode",
        "description": "Use Claude Code's automatic classifier for risky actions.",
    },
    {
        "id": "dontAsk",
        "title": "Don't ask",
        "description": "Deny unapproved tools instead of asking for permission.",
    },
    {
        "id": "bypassPermissions",
        "title": "Bypass permissions",
        "description": "Skip permission prompts and allow unrestricted tool use.",
    },
)


def claude_permission_catalog(
    revision: int,
    query: str | None = None,
    limit: int = 100,
) -> RuntimePermissionCatalog:
    needle = (query or "").strip().lower()
    permissions = tuple(
        _permission_item(item)
        for item in CLAUDE_PERMISSION_MODES
        if not needle
        or needle in str(item["id"]).lower()
        or needle in str(item["title"]).lower()
    )[:limit]
    return RuntimePermissionCatalog(
        runtime="claude",
        revision=revision,
        permissions=permissions,
    )


def permission_mode_from_selection_id(selection_id: str | None) -> str | None:
    if selection_id is None:
        return None
    for item in CLAUDE_PERMISSION_MODES:
        permission_id = str(item["id"])
        if selection_id == _selection_id(permission_id):
            return permission_id
    raise RuntimeInvalidRequestError(
        f"unknown Claude permission selection: {selection_id}"
    )


def _permission_item(item: Mapping[str, Any]) -> RuntimePermissionItem:
    permission_id = str(item["id"])
    return RuntimePermissionItem(
        id=permission_id,
        title=str(item["title"]),
        selection_id=_selection_id(permission_id),
        description=str(item["description"]),
        metadata={
            "default": item.get("default") is True,
            "identity": {"permission_mode": permission_id},
            "runtimeSettings": {"permissionMode": permission_id},
            "nativeSettings": {"permissionMode": permission_id},
        },
    )


def _selection_id(permission_id: str) -> str:
    return protocol_selection_id(
        "claude",
        "permission",
        {"permission_id": permission_id},
    )
