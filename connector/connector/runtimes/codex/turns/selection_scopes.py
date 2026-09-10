from __future__ import annotations

from collections.abc import Mapping


def unsupported_selection_scope(
    selections: Mapping[str, str | None],
) -> str | None:
    unsupported_scopes = set(selections) - {"model", "permission"}
    return min(unsupported_scopes) if unsupported_scopes else None
