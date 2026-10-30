from __future__ import annotations

from collections.abc import Mapping


def web_search_values(
    query: object,
    action: object,
) -> tuple[str | None, str | None]:
    """Normalize native search fields identically for SDK and raw history.

    An explicit empty query is meaningful; only missing/null queries fall back
    to the action's query, URL or pattern. The wire action remains a string.
    """

    details = action if isinstance(action, Mapping) else {}
    action_type = details.get("type") if details else action
    operation = action_type if isinstance(action_type, str) else None
    if isinstance(query, str):
        return query, operation
    keys = {
        "search": ("query",),
        "openPage": ("url",),
        "findInPage": ("pattern", "url"),
    }.get(operation, ())
    for key in keys:
        value = details.get(key)
        if isinstance(value, str):
            return value, operation
    queries = details.get("queries") if operation == "search" else None
    if isinstance(queries, list) and all(isinstance(value, str) for value in queries):
        return "\n".join(queries), operation
    return None, operation
