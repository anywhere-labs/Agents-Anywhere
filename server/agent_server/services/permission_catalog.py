from __future__ import annotations

from agent_server.core.protocol import ProtocolPermissionCatalog


def resolve_permission_selection(
    catalog: ProtocolPermissionCatalog,
    selection_id: str,
) -> dict[str, object]:
    for permission in catalog.permissions:
        if permission.selectionId == selection_id:
            return {"permissionMode": permission.id}
    raise KeyError(selection_id)
