from __future__ import annotations

from agent_server.core.models import AgentCatalogEntry, RuntimeName
from agent_server.core.protocol import (
    ProtocolModelCatalog,
    ProtocolModelItem,
    ProtocolReasoningItem,
    protocol_selection_id,
)


def build_model_catalog(
    *,
    runtime: RuntimeName,
    models: list[AgentCatalogEntry],
    revision: int = 1,
) -> ProtocolModelCatalog:
    return ProtocolModelCatalog(
        runtime=runtime,
        revision=revision,
        models=[_model_item(runtime, model) for model in models],
    )


def resolve_model_selection(
    catalog: ProtocolModelCatalog,
    selection_id: str,
) -> tuple[str, str | None]:
    for model in catalog.models:
        if model.selectionId == selection_id:
            return model.id, None
        for reasoning in model.reasoningItems:
            if reasoning.selectionId == selection_id:
                return model.id, reasoning.id
    raise KeyError(selection_id)


def _model_item(runtime: RuntimeName, model: AgentCatalogEntry) -> ProtocolModelItem:
    reasoning_items = [_reasoning_item(runtime, model, effort) for effort in model.efforts]
    return ProtocolModelItem(
        displayName=model.displayLabel,
        id=model.key,
        selectionId=None
        if reasoning_items
        else protocol_selection_id(
            runtime,
            "model",
            {"model_id": model.key, "reasoning_id": None},
        ),
        description=model.description,
        default=model.isDefault,
        reasoningItems=reasoning_items,
        metadata={"sortOrder": model.sortOrder},
    )


def _reasoning_item(
    runtime: RuntimeName,
    model: AgentCatalogEntry,
    effort: AgentCatalogEntry,
) -> ProtocolReasoningItem:
    return ProtocolReasoningItem(
        displayName=effort.displayLabel,
        id=effort.key,
        fullModelId=model.key,
        selectionId=protocol_selection_id(
            runtime,
            "model",
            {"model_id": model.key, "reasoning_id": effort.key},
        ),
        description=effort.description,
        default=effort.isDefault,
        metadata={"sortOrder": effort.sortOrder},
    )
