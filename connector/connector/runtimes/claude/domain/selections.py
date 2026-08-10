from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from connector.runtimes.claude.domain.models import model_selection_from_selection_id
from connector.runtimes.claude.domain.permissions import permission_mode_from_selection_id


def effective_claude_selections(
    current: Mapping[str, str | None],
    incoming: Mapping[str, str | None] | None,
    *,
    custom_models: Any = None,
) -> dict[str, str | None]:
    effective = dict(current)
    effective.update(dict(incoming or {}))
    model_selection_from_selection_id(
        effective.get("model"),
        custom_models,
    )
    permission_mode_from_selection_id(effective.get("permission"))
    return effective
