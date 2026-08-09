from __future__ import annotations

from dataclasses import dataclass
from typing import Any

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


_CLAUDE_EFFORTS: tuple[dict[str, str], ...] = (
    {
        "id": "low",
        "title": "Low",
        "description": "Quick, straightforward implementation with minimal overhead.",
    },
    {
        "id": "medium",
        "title": "Medium",
        "description": "Balanced approach with standard implementation and testing.",
    },
    {
        "id": "high",
        "title": "High",
        "description": "Comprehensive implementation with deeper reasoning.",
    },
    {
        "id": "xhigh",
        "title": "Extra high",
        "description": "Deeper reasoning than high, just below maximum.",
    },
    {
        "id": "max",
        "title": "Max",
        "description": "Maximum capability with deepest reasoning.",
    },
)


_CLAUDE_MODELS: tuple[dict[str, Any], ...] = (
    {
        "id": "claude-fable-5",
        "title": "Claude Fable 5",
        "description": "Highest-capability generally available Claude model.",
        "family": "fable",
        "generation": "5",
    },
    {
        "id": "claude-opus-5",
        "title": "Claude Opus 5",
        "description": "High-capability Claude model for complex agentic coding.",
        "family": "opus",
        "generation": "5",
    },
    {
        "id": "claude-sonnet-5",
        "title": "Claude Sonnet 5",
        "description": "Balanced Claude model for everyday coding tasks.",
        "family": "sonnet",
        "generation": "5",
    },
    {
        "id": "claude-haiku-4-5-20251001",
        "title": "Claude Haiku 4.5",
        "description": "Fast Claude model for lightweight coding tasks.",
        "family": "haiku",
        "generation": "4.5",
    },
    {
        "id": "claude-opus-4-8",
        "title": "Claude Opus 4.8",
        "description": "Claude Code-supported Opus 4.x model.",
        "family": "opus",
        "generation": "4.8",
        "legacy": True,
    },
    {
        "id": "claude-opus-4-7",
        "title": "Claude Opus 4.7",
        "description": "Claude Code-supported Opus 4.x model.",
        "family": "opus",
        "generation": "4.7",
        "legacy": True,
    },
    {
        "id": "claude-sonnet-4-6",
        "title": "Claude Sonnet 4.6",
        "description": "Claude Code-supported Sonnet 4.x model.",
        "family": "sonnet",
        "generation": "4.6",
        "legacy": True,
    },
    {
        "id": "claude-sonnet-4-5",
        "title": "Claude Sonnet 4.5",
        "description": "Claude Code-supported Sonnet 4.x model.",
        "family": "sonnet",
        "generation": "4.5",
        "legacy": True,
    },
)


def claude_model_catalog(
    revision: int,
    query: str | None = None,
    limit: int = 100,
) -> RuntimeModelCatalog:
    models = tuple(_model_item(model) for model in _CLAUDE_MODELS)
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


def _model_item(item: dict[str, Any]) -> RuntimeModelItem:
    model_id = str(item["id"])
    metadata = {
        "source": "claude-code.static-models",
        "family": item.get("family"),
        "generation": item.get("generation"),
    }
    if item.get("legacy") is True:
        metadata["legacy"] = True
    return RuntimeModelItem(
        id=model_id,
        title=str(item["title"]),
        selection_id=protocol_selection_id(
            "claude",
            "model",
            {"model_id": model_id},
        ),
        description=str(item["description"]),
        reasoning_items=_reasoning_items(model_id),
        metadata=metadata,
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
            description=effort["description"],
            metadata={"source": "claude-agent-sdk.effort"},
        )
        for effort in _CLAUDE_EFFORTS
        for effort_id, title in ((effort["id"], effort["title"]),)
    )
