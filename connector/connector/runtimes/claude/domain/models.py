from __future__ import annotations

from dataclasses import dataclass

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeReasoningItem,
)
from connector.server.protocol import protocol_selection_id


@dataclass(frozen=True, slots=True)
class ClaudeModelSelection:
    model_id: str
    effort_id: str | None = None


def claude_model_catalog(
    revision: int,
    query: str | None = None,
    limit: int = 100,
) -> RuntimeModelCatalog:
    models = tuple(_model_item(model) for model in _model_catalog_items())
    if query:
        lowered = query.casefold()
        models = tuple(
            model
            for model in models
            if lowered in model.id.casefold() or lowered in model.title.casefold()
        )
    return RuntimeModelCatalog(
        runtime="claude",
        revision=revision,
        models=models[:limit],
    )


def model_selection_from_selection_id(
    selection_id: str | None,
) -> ClaudeModelSelection | None:
    if selection_id is None:
        return None
    for model in claude_model_catalog(revision=0).models:
        if model.selection_id == selection_id:
            return ClaudeModelSelection(model_id=model.id)
        for effort in model.reasoning_items:
            if effort.selection_id == selection_id:
                return ClaudeModelSelection(model_id=model.id, effort_id=effort.id)
    raise RuntimeInvalidRequestError("unknown Claude model selection")


def _model_catalog_items() -> tuple[dict[str, str], ...]:
    return (
        {
            "id": "claude-sonnet-4-5",
            "title": "Claude Sonnet 4.5",
            "description": "Balanced Claude Code model from the Claude Agent SDK examples.",
        },
        {
            "id": "claude-opus-4-5",
            "title": "Claude Opus 4.5",
            "description": "Highest-capability Claude Code model from the Claude Agent SDK examples.",
        },
    )


def _model_item(item: dict[str, str]) -> RuntimeModelItem:
    model_id = item["id"]
    return RuntimeModelItem(
        id=model_id,
        title=item["title"],
        selection_id=None,
        description=item.get("description"),
        reasoning_items=_reasoning_items(model_id),
        metadata={"source": "claude-agent-sdk.static-models"},
    )


def _reasoning_items(model_id: str) -> tuple[RuntimeReasoningItem, ...]:
    return tuple(
        RuntimeReasoningItem(
            id=effort_id,
            title=title,
            selection_id=protocol_selection_id(
                "claude",
                "model",
                {"model_id": model_id, "effort_id": effort_id},
            ),
            metadata={"source": "claude-agent-sdk.effort"},
        )
        for effort_id, title in (
            ("low", "Low"),
            ("medium", "Medium"),
            ("high", "High"),
            ("xhigh", "Extra high"),
            ("max", "Max"),
        )
    )
