"""Map the host service's own JSON onto the Connector's runtime types.

Two rules here are load-bearing rather than cosmetic:

* :func:`platform_session_id` reproduces the plugin bridge's derivation **byte for
  byte** (``sess_opencode_`` + ``sha256("<namespace>:opencode:<externalId>")[:24]``).
  If it drifts, every session Agents Anywhere already lists reappears as a brand
  new one, so this is a compatibility constraint, not a style choice.
* :func:`model_catalog` keys models by ``providerID/id`` because the host really
  does repeat a bare ``id`` across providers (measured: 79 rows, four repeated
  ids) while the Agents Anywhere validator rejects a catalog over one duplicate
  ``id`` *or* ``selectionId``. Keying by the provider pair keeps both rows
  selectable instead of collapsing one of them.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from typing import Any

from connector.runtime_protocol import (
    RuntimeAgentCatalog,
    RuntimeAgentItem,
    RuntimeModelCatalog,
    RuntimeModelItem,
    SessionMeta,
)

RUNTIME = "opencode"
AGENT_MODES = frozenset({"primary", "subagent", "all"})


def platform_session_id(namespace: str, external_session_id: str) -> str:
    digest = hashlib.sha256(f"{namespace}:{RUNTIME}:{external_session_id}".encode("utf-8")).hexdigest()
    return f"sess_{RUNTIME}_{digest[:24]}"


def _text(row: Mapping[str, Any], key: str) -> str | None:
    value = row.get(key)
    return value if isinstance(value, str) and value else None


def _flag(row: Mapping[str, Any], key: str, default: bool = False) -> bool:
    value = row.get(key)
    return value if isinstance(value, bool) else default


def session_meta(row: Any, *, namespace: str) -> SessionMeta:
    if not isinstance(row, Mapping):
        raise ValueError("OpenCode session row is not an object")
    external = _text(row, "id")
    if external is None:
        raise ValueError("OpenCode session row has no id")
    location = row.get("location")
    directory = location.get("directory") if isinstance(location, Mapping) else None
    time = row.get("time")
    ordering = time.get("updated") if isinstance(time, Mapping) else None
    metadata: dict[str, Any] = {}
    for key in ("projectID", "parentID", "agent", "model", "outcome", "cost", "tokens"):
        if row.get(key) is not None:
            metadata[key] = row[key]
    return SessionMeta(
        session_id=platform_session_id(namespace, external),
        external_session_id=external,
        runtime=RUNTIME,
        title=_text(row, "title"),
        cwd=directory if isinstance(directory, str) else None,
        ordering_time=str(ordering) if ordering is not None else None,
        metadata=metadata,
    )


def model_catalog(rows: Sequence[Any], *, revision: int = 1) -> RuntimeModelCatalog:
    """`GET /api/model` rows -> the catalog Agents Anywhere stores.

    `selectionId` carries the provider-qualified key and `metadata` keeps the raw
    ``id``/``providerID`` pair, which is exactly what `Model.Ref` needs when a
    turn switches models.
    """
    items: list[RuntimeModelItem] = []
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        model_id = _text(row, "id") or _text(row, "modelID")
        provider_id = _text(row, "providerID")
        if model_id is None or provider_id is None:
            continue
        key = f"{provider_id}/{model_id}"
        metadata: dict[str, Any] = {"id": model_id, "providerID": provider_id}
        for optional in ("family", "capabilities", "limit", "cost", "variants", "status"):
            if row.get(optional) is not None:
                metadata[optional] = row[optional]
        items.append(
            RuntimeModelItem(
                id=key,
                title=_text(row, "name") or _text(row, "title") or key,
                selection_id=key,
                description=_text(row, "description"),
                reasoning_items=(),
                enabled=_flag(row, "enabled", True),
                disabled_reason=_text(row, "disabledReason"),
                metadata=metadata,
            )
        )
    return RuntimeModelCatalog(runtime=RUNTIME, revision=revision, models=tuple(items))


def agent_catalog(rows: Sequence[Any], *, revision: int = 1) -> RuntimeAgentCatalog:
    items: list[RuntimeAgentItem] = []
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        agent_id = _text(row, "id")
        if agent_id is None:
            continue
        mode = row.get("mode")
        items.append(
            RuntimeAgentItem(
                id=agent_id,
                name=_text(row, "name"),
                description=_text(row, "description"),
                mode=mode if mode in AGENT_MODES else "all",
                hidden=_flag(row, "hidden"),
            )
        )
    return RuntimeAgentCatalog(runtime=RUNTIME, revision=revision, agents=tuple(items))
