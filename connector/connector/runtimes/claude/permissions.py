from __future__ import annotations

from collections.abc import Mapping

from connector.runtime_protocol import RuntimePermissionCatalog, RuntimePermissionItem
from connector.server.protocol import protocol_selection_id


def claude_permissions(revision: int) -> RuntimePermissionCatalog:
    items = [
        ("default", "Ask permissions", "Prompt before destructive actions. Read-only commands run automatically.", True),
        ("acceptEdits", "Accept edits", "Auto-approve file edits; still ask for shell commands.", False),
        ("plan", "Plan mode", "Read-only planning. No writes, no commands.", False),
        ("auto", "Auto mode", "Run everything; background classifier flags risky actions.", False),
        ("bypassPermissions", "Bypass permissions", "Skip every prompt. Use with care.", False),
    ]
    return RuntimePermissionCatalog(
        runtime="claude",
        revision=revision,
        permissions=tuple(
            RuntimePermissionItem(
                id=item_id,
                title=title,
                description=description,
                selection_id=protocol_selection_id(
                    "claude",
                    "permission",
                    {"permission_mode": item_id},
                ),
                metadata={
                    "default": is_default,
                    "nativeSettings": {"permissionMode": item_id},
                },
            )
            for item_id, title, description, is_default in items
        ),
    )


def permission_mode_from_selection(selection_id: str | None) -> str | None:
    if selection_id is None:
        return None
    for permission in claude_permissions(1).permissions:
        if permission.selection_id == selection_id:
            native = permission.metadata.get("nativeSettings")
            if isinstance(native, Mapping):
                mode = native.get("permissionMode")
                return mode if isinstance(mode, str) else None
    return None
