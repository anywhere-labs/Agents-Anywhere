"""The model a runtime instance gives new sessions.

``model`` sits next to ``modelGateway`` in the unified runtime config. It only
decides what a new session uses when the client does not choose a model: the
adapter writes it into that session's selections, so existing sessions keep
their own model. Changing it alone never restarts the runtime.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeModelItem,
)
from connector.runtimes.custom_models import normalize_custom_models

RUNTIME_MODEL_FIELD = "model"


@dataclass(frozen=True, slots=True)
class RuntimeModelSetting:
    model_id: str
    effort_id: str | None = None

    def to_config_values(self) -> dict[str, Any]:
        return {
            "modelId": self.model_id,
            **({"effortId": self.effort_id} if self.effort_id is not None else {}),
        }


def runtime_model_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "title": "Model",
        "description": "The model new sessions use when none is chosen. Existing sessions keep their own model.",
        "required": ["modelId"],
        "properties": {
            "modelId": {
                "type": "string",
                "title": "Model ID",
                "minLength": 1,
                "maxLength": 256,
                "pattern": "^[^\\u0000\\r\\n]+$",
            },
            "effortId": {
                "type": "string",
                "title": "Effort ID",
                "minLength": 1,
                "maxLength": 128,
                "pattern": "^[^\\u0000\\r\\n]+$",
            },
        },
        "additionalProperties": False,
    }


def runtime_model_from_config(
    values: Mapping[str, Any],
    *,
    gateway_field: str = "modelGateway",
    models_field: str = "customModels",
) -> RuntimeModelSetting | None:
    """Parse ``values["model"]``; with a connection it must name an imported model."""
    raw = values.get(RUNTIME_MODEL_FIELD)
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise RuntimeInvalidRequestError("model must be an object")
    unknown = set(raw) - {"modelId", "effortId"}
    if unknown:
        raise RuntimeInvalidRequestError(
            f"model contains unsupported fields: {', '.join(sorted(unknown))}"
        )
    model_id = _identifier(raw.get("modelId"), "model.modelId", 256)
    effort_raw = raw.get("effortId")
    effort_id = None if effort_raw is None else _identifier(effort_raw, "model.effortId", 128)
    if values.get(gateway_field):
        models = {
            item["modelId"]: item
            for item in normalize_custom_models(values.get(models_field))
        }
        if model_id not in models:
            raise RuntimeInvalidRequestError(
                f"model.modelId must be one of {models_field} when a model connection is configured"
            )
        efforts = {item["effortId"] for item in models[model_id].get("efforts", [])}
        if effort_id is not None and efforts and effort_id not in efforts:
            raise RuntimeInvalidRequestError("model.effortId is not offered by this model")
    return RuntimeModelSetting(model_id=model_id, effort_id=effort_id)


def mark_runtime_model(
    catalog: RuntimeModelCatalog,
    setting: RuntimeModelSetting | None,
) -> RuntimeModelCatalog:
    """Flag the configured model (and effort) as the catalog's preselected item."""
    if setting is None:
        return catalog
    models = list(catalog.models)
    for index, model in enumerate(models):
        if model.id != setting.model_id or not model.enabled:
            continue
        reasoning_id = _reasoning_id(model, setting.effort_id)
        if reasoning_id is None and model.selection_id is None:
            return catalog
        models[index] = replace(
            model,
            default=True,
            reasoning_items=tuple(
                replace(item, default=item.id == reasoning_id)
                for item in model.reasoning_items
            ),
        )
        return replace(catalog, models=tuple(models))
    return catalog


def configured_selection_id(catalog: RuntimeModelCatalog) -> str | None:
    """Selection id of the item ``mark_runtime_model`` flagged, if any."""
    for model in catalog.models:
        if not model.default:
            continue
        for reasoning in model.reasoning_items:
            if reasoning.default:
                return reasoning.selection_id
        return model.selection_id
    return None


async def selections_with_runtime_model(
    selections: Mapping[str, str | None] | None,
    read_catalog: Callable[[], Awaitable[RuntimeModelCatalog]],
) -> dict[str, str | None]:
    """A new session without a chosen model takes the runtime's model setting.

    Writing it into the session's own selections keeps that session on it
    after the setting changes later. A catalog that cannot be read leaves the
    choice to the runtime, as before the setting existed.
    """
    result = dict(selections or {})
    if result.get("model"):
        return result
    try:
        catalog = await read_catalog()
    except Exception:  # noqa: BLE001 -- the session still starts on the runtime's own model
        logger.exception("runtime model catalog unavailable for a new session")
        return result
    if selection := configured_selection_id(catalog):
        result["model"] = selection
    return result


def _reasoning_id(model: RuntimeModelItem, effort_id: str | None) -> str | None:
    enabled = [item for item in model.reasoning_items if item.enabled]
    if effort_id is not None:
        for item in enabled:
            if item.id == effort_id:
                return item.id
    if model.selection_id is not None or not enabled:
        return None
    # A model that is only selectable by effort takes the runtime's recommended one.
    raw = model.metadata.get("raw")
    recommended = raw.get("defaultReasoningEffort") if isinstance(raw, Mapping) else None
    for item in enabled:
        if item.id == recommended:
            return item.id
    return enabled[0].id


def _identifier(value: Any, name: str, max_length: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeInvalidRequestError(f"{name} must be a non-empty string")
    value = value.strip()
    if len(value) > max_length:
        raise RuntimeInvalidRequestError(f"{name} is too long")
    if "\x00" in value or "\r" in value or "\n" in value:
        raise RuntimeInvalidRequestError(f"{name} contains unsupported characters")
    return value
