from __future__ import annotations

from typing import Literal

from agent_server.core.protocol import (
    ProtocolModelCatalog,
    ProtocolPermissionCatalog,
)

CatalogType = Literal["model", "permission"]
CatalogUpdateOutcome = Literal["accepted", "idempotent", "stale", "conflict"]


class CatalogDomainError(ValueError):
    pass


def validate_model_catalog(catalog: ProtocolModelCatalog) -> None:
    _require_unique("model id", [model.id for model in catalog.models])
    _require_at_most_one_default(
        "model catalog",
        [model.default for model in catalog.models],
    )
    selection_ids: list[str] = []
    for model in catalog.models:
        _require_unique(
            f"reasoning id for model {model.id}",
            [reasoning.id for reasoning in model.reasoningItems],
        )
        _require_at_most_one_default(
            f"reasoning items for model {model.id}",
            [reasoning.default for reasoning in model.reasoningItems],
        )
        if model.selectionId is None and not model.reasoningItems:
            raise CatalogDomainError(f"model {model.id} must define a selection id or reasoning items")
        if model.selectionId is not None:
            selection_ids.append(model.selectionId)
        selection_ids.extend(reasoning.selectionId for reasoning in model.reasoningItems)
    _require_unique("model selection id", selection_ids)


def validate_permission_catalog(catalog: ProtocolPermissionCatalog) -> None:
    _require_unique(
        "permission id",
        [permission.id for permission in catalog.permissions],
    )
    _require_unique(
        "permission selection id",
        [permission.selectionId for permission in catalog.permissions],
    )
    _require_at_most_one_default(
        "permission catalog",
        [permission.default for permission in catalog.permissions],
    )


def _require_unique(label: str, values: list[str]) -> None:
    seen: set[str] = set()
    for value in values:
        if not value:
            raise CatalogDomainError(f"{label} must not be empty")
        if value in seen:
            raise CatalogDomainError(f"duplicate {label}: {value}")
        seen.add(value)


def _require_at_most_one_default(label: str, values: list[bool]) -> None:
    if sum(values) > 1:
        raise CatalogDomainError(f"{label} defines multiple defaults")
