from __future__ import annotations

from typing import Any, Literal

from pydantic import ValidationError

from agent_server.core.protocol import (
    ProtocolModelCatalog,
    ProtocolPermissionCatalog,
)

CatalogType = Literal["model", "permission"]
CatalogUpdateOutcome = Literal["accepted", "idempotent", "stale", "conflict"]
SameRevisionMatch = Literal["idempotent", "regrouped", "conflict"]


class CatalogDomainError(ValueError):
    pass


def compare_same_revision_catalogs(
    catalog_type: CatalogType,
    stored: Any,
    incoming: dict[str, Any],
) -> SameRevisionMatch:
    """Compare two catalogs that report the same revision.

    A stored catalog may predate fields added to the protocol since it was
    written, so both sides go through the current model first: a difference
    that is only a field's default is the same catalog. Model groups are
    derived by the Connector from the rest of the catalog (DSH provider
    metadata), so a newer Connector can add them without the runtime bumping
    its revision; that is ``regrouped`` and should replace the stored copy.
    """

    model = ProtocolModelCatalog if catalog_type == "model" else ProtocolPermissionCatalog
    try:
        current = model.model_validate(stored).model_dump(mode="json")
        reported = model.model_validate(incoming).model_dump(mode="json")
    except ValidationError:
        return "idempotent" if stored == incoming else "conflict"
    if current == reported:
        return "idempotent"
    if catalog_type == "model" and _without_model_groups(current) == _without_model_groups(
        reported
    ):
        return "regrouped"
    return "conflict"


def _without_model_groups(catalog: dict[str, Any]) -> dict[str, Any]:
    return {
        **catalog,
        "models": [
            {key: value for key, value in item.items() if key != "group"}
            for item in catalog.get("models", [])
        ],
    }


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
