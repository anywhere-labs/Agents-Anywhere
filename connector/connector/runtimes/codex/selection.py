from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from connector.runtime_protocol import RuntimeModelCatalog, RuntimePermissionCatalog

ModelCatalogReader = Callable[[], Awaitable[RuntimeModelCatalog]]
PermissionCatalogReader = Callable[[], Awaitable[RuntimePermissionCatalog]]


async def model_settings_from_selection(
    selection_id: str | None,
    read_catalog: ModelCatalogReader,
) -> dict[str, str]:
    if selection_id is None:
        return {}
    catalog = await read_catalog()
    for model in catalog.models:
        if model.selection_id == selection_id:
            return {"model": model.id}
        for reasoning in model.reasoning_items:
            if reasoning.selection_id == selection_id:
                return {"model": model.id, "effort": reasoning.id}
    return {}


async def permission_settings_from_selection(
    selection_id: str | None,
    read_catalog: PermissionCatalogReader,
) -> dict[str, Any]:
    if selection_id is None:
        return {}
    catalog = await read_catalog()
    for permission in catalog.permissions:
        if permission.selection_id == selection_id:
            native = permission.metadata.get("nativeSettings")
            return dict(native) if isinstance(native, dict) else {}
    return {}
