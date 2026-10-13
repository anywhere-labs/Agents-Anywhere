from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeReasoningItem,
)
from connector.runtimes.custom_models import custom_model_items
from connector.server.protocol import protocol_selection_id

# Claude Code's `/model` entry that means "no --model flag".
CLAUDE_DEFAULT_MODEL_ID = "default"


@dataclass(frozen=True, slots=True)
class ClaudeModelSelection:
    model_id: str
    effort_id: str | None = None

    @property
    def cli_model(self) -> str | None:
        return None if self.model_id == CLAUDE_DEFAULT_MODEL_ID else self.model_id


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
    custom_models: object | None = None,
    cli_models: Sequence[Mapping[str, Any]] = (),
) -> RuntimeModelCatalog:
    """Build the picker catalog.

    `cli_models` is the list Claude Code reports at initialize; when it is
    available it replaces the static table so new CLI models show up without a
    Connector release. The static table remains the fallback.
    """

    if cli_models:
        models = tuple(_cli_model_item(model) for model in cli_models)
    else:
        models = tuple(_model_item(model) for model in _CLAUDE_MODELS)
    models = (
        *models,
        *custom_model_items(
            "claude",
            custom_models,
            existing_model_ids={model.id for model in models},
        ),
    )
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
    custom_models: object | None = None,
    cli_models: Sequence[Mapping[str, Any]] = (),
) -> ClaudeModelSelection | None:
    if selection_id is None:
        return None
    for model in _selection_candidates(custom_models, cli_models):
        if model.selection_id == selection_id:
            return ClaudeModelSelection(model_id=model.id)
        for effort in model.reasoning_items:
            if effort.selection_id == selection_id:
                return ClaudeModelSelection(model_id=model.id, effort_id=effort.id)
    raise RuntimeInvalidRequestError("unknown Claude model selection")


def _selection_candidates(
    custom_models: object | None,
    cli_models: Sequence[Mapping[str, Any]],
) -> tuple[RuntimeModelItem, ...]:
    # Sessions keep the selection ids they were created with, so static
    # entries stay resolvable even while the picker shows the CLI list.
    candidates = list(
        claude_model_catalog(
            revision=0,
            custom_models=custom_models,
            cli_models=cli_models,
        ).models
    )
    # A CLI entry can reuse a static model id while reporting fewer efforts.
    # Keep its saved static selections resolvable without adding those efforts
    # to the picker, which continues to show the CLI's reported capabilities.
    candidates.extend(_model_item(model) for model in _CLAUDE_MODELS)
    return tuple(candidates)


_FAMILIES = {"fable": "Fable", "opus": "Opus", "sonnet": "Sonnet", "haiku": "Haiku"}
# Anthropic ids, optionally behind a Bedrock prefix ("anthropic.", "us.anthropic.", "global.anthropic.").
_PROVIDER_PREFIX = r"^(?:(?:[a-z]{2,6}\.)?anthropic\.)?"
# What may follow the version: end, [1m], a Vertex "@date", a dated id ("-20251001"), or a
# Bedrock revision ("-v1:0"). A date is not a minor version.
_VERSION_END = r"(?=$|\[|@|-\d{8}|-v\d)"
# claude-opus-5-5[1m], claude-haiku-4-5-20251001, us.anthropic.claude-opus-4-1-20250805-v1:0,
# claude-opus-4-1@20250805.
_RESOLVED_MODEL = re.compile(
    _PROVIDER_PREFIX + r"claude-(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?" + _VERSION_END,
    re.IGNORECASE,
)
# Older ids put the version first: claude-3-5-sonnet-20241022, anthropic.claude-3-haiku-20240307-v1:0.
_RESOLVED_LEGACY_MODEL = re.compile(
    _PROVIDER_PREFIX + r"claude-(\d)(?:-(\d))?-(opus|sonnet|haiku)" + r"(?=$|\[|@|-\d{8}|-v\d|-latest)",
    re.IGNORECASE,
)
# "Opus 5.5 · ...", "Opus 5.5 for long sessions", "Use the default model (currently Opus 5.5)".
_DESCRIBED_MODEL = re.compile(
    r"(?:^|\(currently )(Fable|Opus|Sonnet|Haiku) (\d{1,2}(?:\.\d{1,2})?)(?![\d.])"
)
_ONE_MILLION = "1M context"


def _cli_model_title(item: Mapping[str, Any], name: str) -> str:
    """Title in Claude Code's status-line form: version and context window, e.g. "Opus 5.5 (1M context)".

    Claude Code labels aliases by family only ("Opus", "Opus (1M context)") and carries the
    version in `resolvedModel`; `description` is read only when `resolvedModel` is absent.
    Entries without a recognizable Claude version, such as gateway or custom models, keep the
    label Claude Code reported.
    """

    version = _cli_model_version(item)
    if version is None:
        return name
    identifiers = (item.get("value"), item.get("resolvedModel"))
    one_million = _ONE_MILLION in name or any(
        isinstance(value, str) and "[1m]" in value.casefold() for value in identifiers
    )
    if item.get("value") == CLAUDE_DEFAULT_MODEL_ID:
        return f"Default ({version}, {_ONE_MILLION})" if one_million else f"Default ({version})"
    return f"{version} ({_ONE_MILLION})" if one_million else version


def _cli_model_version(item: Mapping[str, Any]) -> str | None:
    resolved = item.get("resolvedModel")
    if isinstance(resolved, str) and resolved:
        # When Claude Code names the model, trust only that name: a gateway model such as
        # "deepseek-v4" may well carry a description starting with "Opus 5.5".
        match = _RESOLVED_MODEL.match(resolved)
        if match:
            family, major, minor = match.groups()
            return f"{_FAMILIES[family.casefold()]} {major}{f'.{minor}' if minor else ''}"
        match = _RESOLVED_LEGACY_MODEL.match(resolved)
        if match:
            major, minor, family = match.groups()
            return f"{_FAMILIES[family.casefold()]} {major}{f'.{minor}' if minor else ''}"
        return None
    description = item.get("description")
    if isinstance(description, str):
        match = _DESCRIBED_MODEL.search(description)
        if match:
            return f"{match.group(1)} {match.group(2)}"
    return None


def _cli_model_item(item: Mapping[str, Any]) -> RuntimeModelItem:
    model_id = str(item["value"])
    display_name = item.get("displayName")
    description = item.get("description")
    metadata: dict[str, Any] = {"source": "claude-code.initialize"}
    resolved_model = item.get("resolvedModel")
    if isinstance(resolved_model, str) and resolved_model:
        metadata["resolvedModel"] = resolved_model
    for key in ("supportsFastMode", "supportsAutoMode", "supportsAdaptiveThinking"):
        if isinstance(item.get(key), bool):
            metadata[key] = item[key]
    name = display_name if isinstance(display_name, str) and display_name else model_id
    title = _cli_model_title(item, name)
    if title != name:
        metadata["cliDisplayName"] = name
    return RuntimeModelItem(
        id=model_id,
        title=title,
        selection_id=protocol_selection_id(
            "claude",
            "model",
            {"model_id": model_id},
        ),
        description=description if isinstance(description, str) else None,
        reasoning_items=_reasoning_items(model_id, _cli_effort_ids(item)),
        metadata=metadata,
    )


def _cli_effort_ids(item: Mapping[str, Any]) -> tuple[str, ...]:
    if item.get("supportsEffort") is not True:
        return ()
    levels = item.get("supportedEffortLevels")
    if not isinstance(levels, list):
        return ()
    return tuple(level for level in levels if isinstance(level, str) and level)


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


def _reasoning_items(
    model_id: str,
    effort_ids: Sequence[str] | None = None,
) -> tuple[RuntimeReasoningItem, ...]:
    known = {effort["id"]: effort for effort in _CLAUDE_EFFORTS}
    ids = tuple(known) if effort_ids is None else tuple(effort_ids)
    return tuple(
        RuntimeReasoningItem(
            id=effort_id,
            title=known[effort_id]["title"] if effort_id in known else effort_id,
            selection_id=protocol_selection_id(
                "claude",
                "model",
                {"model_id": model_id, "effort_id": effort_id},
            ),
            description=known[effort_id]["description"] if effort_id in known else None,
            metadata={"source": "claude-agent-sdk.effort"},
        )
        for effort_id in ids
    )
