from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeModelItem,
)
from connector.server.protocol import protocol_selection_id

MAX_CUSTOM_MODELS = 64


@dataclass(frozen=True, slots=True)
class CustomRuntimeModel:
    model_id: str
    display_name: str


def custom_models_schema() -> dict[str, Any]:
    return {
        "type": "array",
        "title": "Custom models",
        "description": "Additional model IDs to show in the model catalog for this runtime.",
        "maxItems": MAX_CUSTOM_MODELS,
        "items": {
            "type": "object",
            "required": ["modelId", "displayName"],
            "properties": {
                "modelId": {
                    "type": "string",
                    "title": "Model ID",
                    "description": "The exact model ID passed to the runtime.",
                    "minLength": 1,
                    "maxLength": 256,
                    "pattern": "^[^\\u0000\\r\\n]+$",
                },
                "displayName": {
                    "type": "string",
                    "title": "Display model name",
                    "description": "The name shown in model pickers.",
                    "minLength": 1,
                    "maxLength": 128,
                },
            },
            "additionalProperties": False,
        },
        "default": [],
    }


def normalize_custom_models(raw: Any) -> list[dict[str, str]]:
    models = _custom_models_from_raw(raw)
    return [
        {"modelId": model.model_id, "displayName": model.display_name}
        for model in models
    ]


def custom_model_items(
    runtime: str,
    raw: Any,
    *,
    existing_model_ids: set[str] | None = None,
) -> tuple[RuntimeModelItem, ...]:
    seen = set(existing_model_ids or set())
    items: list[RuntimeModelItem] = []
    for model in _custom_models_from_raw(raw):
        if model.model_id in seen:
            continue
        seen.add(model.model_id)
        items.append(
            RuntimeModelItem(
                id=model.model_id,
                title=model.display_name,
                selection_id=custom_model_selection_id(runtime, model.model_id),
                description="Custom model configured for this runtime.",
                metadata={
                    "source": "runtime.config.customModels",
                    "custom": True,
                },
            )
        )
    return tuple(items)


def custom_model_selection_id(runtime: str, model_id: str) -> str:
    identity: dict[str, Any]
    if runtime == "codex":
        identity = {"model_id": model_id, "reasoning_id": None}
    else:
        identity = {"model_id": model_id}
    return protocol_selection_id(runtime, "model", identity)


def _custom_models_from_raw(raw: Any) -> tuple[CustomRuntimeModel, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise RuntimeInvalidRequestError("customModels must be an array")
    if len(raw) > MAX_CUSTOM_MODELS:
        raise RuntimeInvalidRequestError(
            f"customModels cannot contain more than {MAX_CUSTOM_MODELS} models"
        )

    result: list[CustomRuntimeModel] = []
    seen: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise RuntimeInvalidRequestError(
                f"customModels[{index}] must be an object"
            )
        model_id = _clean_string(item.get("modelId"))
        display_name = _clean_string(item.get("displayName"))
        if model_id is None:
            raise RuntimeInvalidRequestError(
                f"customModels[{index}].modelId must be a non-empty string"
            )
        if display_name is None:
            raise RuntimeInvalidRequestError(
                f"customModels[{index}].displayName must be a non-empty string"
            )
        if "\x00" in model_id or "\r" in model_id or "\n" in model_id:
            raise RuntimeInvalidRequestError(
                f"customModels[{index}].modelId contains unsupported characters"
            )
        if len(model_id) > 256:
            raise RuntimeInvalidRequestError(
                f"customModels[{index}].modelId is too long"
            )
        if len(display_name) > 128:
            raise RuntimeInvalidRequestError(
                f"customModels[{index}].displayName is too long"
            )
        if model_id in seen:
            raise RuntimeInvalidRequestError(
                f"customModels contains duplicate modelId: {model_id}"
            )
        seen.add(model_id)
        result.append(CustomRuntimeModel(model_id=model_id, display_name=display_name))
    return tuple(result)


def _clean_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None
