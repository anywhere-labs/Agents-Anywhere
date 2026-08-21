from __future__ import annotations

from typing import Any

KNOWN_RUNTIME_CAPABILITY_IDS = {
    "codex",
    "claude",
    "dsh",
    "opencode",
    "acp",
}

_RUNTIME_CAPABILITY_MAP: tuple[tuple[str, str], ...] = (
    ("modelCatalog", "catalog.model"),
    ("modelCatalog", "catalog.effort"),
    ("permissionCatalog", "catalog.permission"),
    ("startTurn", "session.send_message"),
    ("steerTurn", "session.steer"),
    ("interruptTurn", "session.interrupt"),
    ("commands", "session.commands"),
    ("interactions", "session.interaction.approval"),
    ("attachments", "runtime.attachment"),
)


def protocol_capabilities_from_inventory(
    inventory: dict[str, Any],
    *,
    revision: int = 1,
) -> dict[str, Any]:
    capabilities: list[dict[str, Any]] = []
    runtimes = inventory.get("runtimes")
    if not isinstance(runtimes, list):
        return {"revision": revision, "capabilities": capabilities}

    for runtime_item in runtimes:
        if not isinstance(runtime_item, dict):
            continue
        runtime_id = runtime_item.get("runtimeId")
        if runtime_id not in KNOWN_RUNTIME_CAPABILITY_IDS:
            continue
        raw_capabilities = runtime_item.get("capabilities")
        if not isinstance(raw_capabilities, dict):
            raw_capabilities = {}
        configured = runtime_item.get("configured") is True
        status = runtime_item.get("status")
        base_available = configured and status in {"available", "running"}

        for inventory_key, protocol_id in _RUNTIME_CAPABILITY_MAP:
            if inventory_key not in raw_capabilities:
                continue
            supported = raw_capabilities.get(inventory_key) is True
            capabilities.append(
                {
                    "capabilityId": protocol_id,
                    "scope": "runtime",
                    "runtime": runtime_id,
                    "supported": supported,
                    "available": supported and base_available,
                    "allowed": True,
                }
            )

        if runtime_item.get("schema") is not None:
            capabilities.append(
                {
                    "capabilityId": "runtime.config",
                    "scope": "runtime",
                    "runtime": runtime_id,
                    "supported": True,
                    "available": base_available,
                    "allowed": True,
                }
            )

    return {"revision": revision, "capabilities": capabilities}
