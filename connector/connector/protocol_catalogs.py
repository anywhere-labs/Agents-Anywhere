from __future__ import annotations

from typing import Any

from connector.protocol import (
    ProtocolModelCatalog,
    ProtocolModelItem,
    ProtocolPermissionCatalog,
    ProtocolPermissionItem,
    ProtocolReasoningItem,
    RuntimeName,
    protocol_selection_id,
)


def empty_model_catalog(runtime: RuntimeName, *, revision: int) -> ProtocolModelCatalog:
    return ProtocolModelCatalog(
        runtime=runtime,
        revision=revision,
        models=[],
    )


def model_catalog_from_runtime_items(
    runtime: RuntimeName,
    *,
    revision: int,
    items: list[dict[str, Any]],
) -> ProtocolModelCatalog:
    models: list[ProtocolModelItem] = []
    for index, item in enumerate(items):
        model_id = _first_string(item, "id", "model", "modelId", "model_id", "name")
        if not model_id:
            continue
        label = _first_string(item, "displayName", "display_name", "label", "name") or model_id
        raw_reasoning = _first_list(
            item,
            "reasoningItems",
            "reasoning_items",
            "reasoningEfforts",
            "reasoning_efforts",
            "supportedReasoningEfforts",
            "supported_reasoning_efforts",
            "efforts",
        )
        default_reasoning = _first_string(item, "defaultReasoningEffort", "default_reasoning_effort")
        reasoning_items = _reasoning_items(
            runtime,
            model_id,
            raw_reasoning,
            default_reasoning_id=default_reasoning,
        )
        models.append(
            ProtocolModelItem(
                id=model_id,
                displayName=label,
                description=_first_string(item, "description"),
                default=_bool_value(item.get("default") if "default" in item else item.get("isDefault"), fallback=index == 0),
                selectionId=None
                if reasoning_items
                else protocol_selection_id(
                    runtime,
                    "model",
                    {"model_id": model_id, "reasoning_id": None},
                ),
                reasoningItems=reasoning_items,
                metadata={"source": "runtime", "raw": item},
            )
        )
    return ProtocolModelCatalog(runtime=runtime, revision=revision, models=models)


def permission_catalog_from_items(
    runtime: RuntimeName,
    *,
    revision: int,
    items: list[dict[str, Any]],
) -> ProtocolPermissionCatalog:
    return ProtocolPermissionCatalog(
        runtime=runtime,
        revision=revision,
        permissions=[
            ProtocolPermissionItem(
                id=str(item["id"]),
                displayName=str(item["label"]),
                description=item.get("description") if isinstance(item.get("description"), str) else None,
                default=bool(item.get("default")),
                selectionId=protocol_selection_id(
                    runtime,
                    "permission",
                    item.get("identity") if isinstance(item.get("identity"), dict) else {"permission_id": item["id"]},
                ),
                metadata={
                    "source": "adapter",
                    **({"runtimeSettings": item["runtimeSettings"]} if isinstance(item.get("runtimeSettings"), dict) else {}),
                },
            )
            for item in items
            if isinstance(item.get("id"), str) and item.get("id")
            and isinstance(item.get("label"), str) and item.get("label")
        ],
    )


def _reasoning_items(
    runtime: RuntimeName,
    model_id: str,
    raw_items: list[Any],
    *,
    default_reasoning_id: str | None,
) -> list[ProtocolReasoningItem]:
    result: list[ProtocolReasoningItem] = []
    for index, raw in enumerate(raw_items):
        item = raw if isinstance(raw, dict) else {"id": raw}
        reasoning_id = _first_string(item, "id", "reasoningEffort", "reasoning_effort", "effort", "reasoning", "value", "name")
        if not reasoning_id:
            continue
        label = _first_string(item, "displayName", "display_name", "label", "name") or _reasoning_label(reasoning_id)
        result.append(
            ProtocolReasoningItem(
                id=reasoning_id,
                displayName=label,
                fullModelId=model_id,
                description=_first_string(item, "description"),
                default=_bool_value(
                    item.get("default") if "default" in item else item.get("isDefault"),
                    fallback=reasoning_id == default_reasoning_id if default_reasoning_id else index == 0,
                ),
                selectionId=protocol_selection_id(
                    runtime,
                    "model",
                    {"model_id": model_id, "reasoning_id": reasoning_id},
                ),
                metadata={"source": "runtime", "raw": item},
            )
        )
    return result


def _reasoning_label(reasoning_id: str) -> str:
    return {
        "low": "Low",
        "medium": "Medium",
        "high": "High",
        "xhigh": "Extra high",
        "max": "Max",
        "ultra": "Ultra",
    }.get(reasoning_id, reasoning_id)


def _first_string(item: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _first_list(item: dict[str, Any], *keys: str) -> list[Any]:
    for key in keys:
        value = item.get(key)
        if isinstance(value, list):
            return value
    return []


def _bool_value(value: Any, *, fallback: bool) -> bool:
    return value if isinstance(value, bool) else fallback
