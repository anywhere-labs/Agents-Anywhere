from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeModelItem,
    RuntimeReasoningItem,
)
from connector.server.protocol import protocol_selection_id

MAX_CUSTOM_MODELS = 64
MAX_CUSTOM_MODEL_EFFORTS = 16


@dataclass(frozen=True, slots=True)
class CustomRuntimeEffort:
    effort_id: str
    display_name: str


@dataclass(frozen=True, slots=True)
class CustomRuntimeModel:
    model_id: str
    display_name: str
    efforts: tuple[CustomRuntimeEffort, ...] = ()


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
                "efforts": {
                    "type": "array",
                    "title": "Efforts",
                    "description": "Optional reasoning efforts to show under this model.",
                    "maxItems": MAX_CUSTOM_MODEL_EFFORTS,
                    "items": {
                        "type": "object",
                        "required": ["effortId", "displayName"],
                        "properties": {
                            "effortId": {
                                "type": "string",
                                "title": "Effort ID",
                                "description": "The exact effort ID passed to the runtime.",
                                "minLength": 1,
                                "maxLength": 128,
                                "pattern": "^[^\\u0000\\r\\n]+$",
                            },
                            "displayName": {
                                "type": "string",
                                "title": "Display effort name",
                                "description": "The name shown in effort pickers.",
                                "minLength": 1,
                                "maxLength": 128,
                            },
                        },
                        "additionalProperties": False,
                    },
                    "default": [],
                },
            },
            "additionalProperties": False,
        },
        "default": [],
    }


def normalize_custom_models(raw: Any) -> list[dict[str, Any]]:
    models = _custom_models_from_raw(raw)
    normalized: list[dict[str, Any]] = []
    for model in models:
        item: dict[str, Any] = {
            "modelId": model.model_id,
            "displayName": model.display_name,
        }
        if model.efforts:
            item["efforts"] = [
                {
                    "effortId": effort.effort_id,
                    "displayName": effort.display_name,
                }
                for effort in model.efforts
            ]
        normalized.append(item)
    return normalized


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
                selection_id=None
                if runtime == "codex" and model.efforts
                else custom_model_selection_id(runtime, model.model_id),
                reasoning_items=_custom_reasoning_items(runtime, model),
                description="Custom model configured for this runtime.",
                metadata={
                    "source": "runtime.config.customModels",
                    "custom": True,
                },
            )
        )
    return tuple(items)


def custom_model_selection_id(
    runtime: str,
    model_id: str,
    effort_id: str | None = None,
) -> str:
    identity: dict[str, Any]
    if runtime == "codex":
        identity = {"model_id": model_id, "reasoning_id": effort_id}
    elif effort_id is not None:
        identity = {"model_id": model_id, "effort_id": effort_id}
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
        result.append(
            CustomRuntimeModel(
                model_id=model_id,
                display_name=display_name,
                efforts=_custom_efforts_from_raw(item.get("efforts"), index),
            )
        )
    return tuple(result)


def _custom_efforts_from_raw(
    raw: Any,
    model_index: int,
) -> tuple[CustomRuntimeEffort, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise RuntimeInvalidRequestError(
            f"customModels[{model_index}].efforts must be an array"
        )
    if len(raw) > MAX_CUSTOM_MODEL_EFFORTS:
        raise RuntimeInvalidRequestError(
            f"customModels[{model_index}].efforts cannot contain more than "
            f"{MAX_CUSTOM_MODEL_EFFORTS} efforts"
        )

    result: list[CustomRuntimeEffort] = []
    seen: set[str] = set()
    for effort_index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise RuntimeInvalidRequestError(
                f"customModels[{model_index}].efforts[{effort_index}] must be an object"
            )
        effort_id = _clean_string(item.get("effortId"))
        display_name = _clean_string(item.get("displayName"))
        if effort_id is None:
            raise RuntimeInvalidRequestError(
                f"customModels[{model_index}].efforts[{effort_index}].effortId "
                "must be a non-empty string"
            )
        if display_name is None:
            raise RuntimeInvalidRequestError(
                f"customModels[{model_index}].efforts[{effort_index}].displayName "
                "must be a non-empty string"
            )
        if "\x00" in effort_id or "\r" in effort_id or "\n" in effort_id:
            raise RuntimeInvalidRequestError(
                f"customModels[{model_index}].efforts[{effort_index}].effortId "
                "contains unsupported characters"
            )
        if len(effort_id) > 128:
            raise RuntimeInvalidRequestError(
                f"customModels[{model_index}].efforts[{effort_index}].effortId "
                "is too long"
            )
        if len(display_name) > 128:
            raise RuntimeInvalidRequestError(
                f"customModels[{model_index}].efforts[{effort_index}].displayName "
                "is too long"
            )
        if effort_id in seen:
            raise RuntimeInvalidRequestError(
                f"customModels[{model_index}].efforts contains duplicate effortId: "
                f"{effort_id}"
            )
        seen.add(effort_id)
        result.append(
            CustomRuntimeEffort(effort_id=effort_id, display_name=display_name)
        )
    return tuple(result)


def _custom_reasoning_items(
    runtime: str,
    model: CustomRuntimeModel,
) -> tuple[RuntimeReasoningItem, ...]:
    return tuple(
        RuntimeReasoningItem(
            id=effort.effort_id,
            title=effort.display_name,
            selection_id=custom_model_selection_id(
                runtime,
                model.model_id,
                effort.effort_id,
            ),
            metadata={
                "source": "runtime.config.customModels.efforts",
                "custom": True,
            },
        )
        for effort in model.efforts
    )


def _clean_string(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None
