from __future__ import annotations

from agent_server.core.models import AgentCatalogEntry, RuntimeName
from agent_server.core.protocol import (
    ProtocolPermissionCatalog,
    ProtocolPermissionItem,
    protocol_selection_id,
)
from agent_server.core.runtime_config import DEFAULT_RUNTIME_CONFIG_SCHEMAS


def build_permission_catalog(
    *,
    runtime: RuntimeName,
    permissions: list[AgentCatalogEntry],
    revision: int = 1,
) -> ProtocolPermissionCatalog:
    entries = permissions or _default_permission_entries_from_runtime_schema(runtime)
    return ProtocolPermissionCatalog(
        runtime=runtime,
        revision=revision,
        permissions=[_permission_item(runtime, entry) for entry in entries],
    )


def resolve_permission_selection(
    catalog: ProtocolPermissionCatalog,
    selection_id: str,
) -> str:
    for permission in catalog.permissions:
        if permission.selectionId == selection_id:
            return permission.id
    raise KeyError(selection_id)


def _permission_item(runtime: RuntimeName, entry: AgentCatalogEntry) -> ProtocolPermissionItem:
    return ProtocolPermissionItem(
        displayName=entry.displayLabel,
        id=entry.key,
        selectionId=protocol_selection_id(
            runtime,
            "permission",
            {"permission_mode": entry.key},
        ),
        description=entry.description,
        default=entry.isDefault,
        metadata={"sortOrder": entry.sortOrder},
    )


def _default_permission_entries_from_runtime_schema(runtime: RuntimeName) -> list[AgentCatalogEntry]:
    schema = DEFAULT_RUNTIME_CONFIG_SCHEMAS[runtime]
    permission_field = next((field for field in schema.fields if field.key == "permissionMode"), None)
    if permission_field is None or not permission_field.options:
        return []
    return [
        AgentCatalogEntry(
            runtime=runtime,
            key=str(option.value),
            displayLabel=option.label,
            description=option.description,
            isDefault=index == 0,
            sortOrder=index + 1,
            efforts=[],
        )
        for index, option in enumerate(permission_field.options)
    ]
