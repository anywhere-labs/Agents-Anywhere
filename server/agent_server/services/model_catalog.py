from __future__ import annotations

from agent_server.core.protocol import ProtocolModelCatalog


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
