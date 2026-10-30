"""Shared model-catalog wire projection for queries and workspace workflows."""

from __future__ import annotations

from typing import Any

from .models import RuntimeModelCatalog


def model_catalog_payload(catalog: RuntimeModelCatalog) -> dict[str, Any]:
    return {
        "runtime": catalog.runtime,
        **({"runtimeId": catalog.runtime_id} if catalog.runtime_id is not None else {}),
        "revision": catalog.revision,
        "models": [
            {
                "id": model.id,
                "displayName": model.title,
                "selectionId": model.selection_id,
                "description": model.description,
                "default": False,
                "reasoningItems": [
                    {
                        "id": reasoning.id,
                        "displayName": reasoning.title,
                        "selectionId": reasoning.selection_id,
                        "description": reasoning.description,
                        "default": False,
                        "metadata": {
                            **dict(reasoning.metadata),
                            "enabled": reasoning.enabled,
                            **(
                                {"disabledReason": reasoning.disabled_reason}
                                if reasoning.disabled_reason is not None
                                else {}
                            ),
                        },
                    }
                    for reasoning in model.reasoning_items
                ],
                "group": (
                    {
                        "id": model.group.id,
                        "displayName": model.group.title,
                        "itemDisplayName": model.group.item_title,
                    }
                    if model.group is not None
                    else None
                ),
                "metadata": {
                    **dict(model.metadata),
                    "enabled": model.enabled,
                    **(
                        {"disabledReason": model.disabled_reason}
                        if model.disabled_reason is not None
                        else {}
                    ),
                },
            }
            for model in catalog.models
        ],
    }
