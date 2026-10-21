"""Turn history conversion for IPC-followed threads.

The owner window's ``conversationState`` keeps turns in ``turnHistory.history``
as a keyed entity map plus ordered ``islands`` of entries. The Connector's
timeline projection understands the app-server ``thread/read`` shape instead
(``{"turns": [{"id", "status", "items": [...]}]}``), so this module converts
between the two. Only the fields verified in ``docs/codex-ipc-takeover.md``
are read.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

TERMINAL_TURN_STATUSES = {"completed", "failed", "interrupted", "cancelled", "aborted"}


def turn_entities_in_order(state: Mapping[str, Any]) -> list[tuple[str, Mapping[str, Any]]]:
    """Return ``(entity_key, turn_entity)`` pairs in display order."""

    history = state.get("turnHistory")
    history = history.get("history") if isinstance(history, Mapping) else None
    if not isinstance(history, Mapping):
        return []
    entities = history.get("entitiesByKey")
    islands = history.get("islands")
    if not isinstance(entities, Mapping):
        return []
    ordered: list[tuple[str, Mapping[str, Any]]] = []
    seen: set[str] = set()
    if isinstance(islands, list):
        for island in islands:
            entries = island.get("entries") if isinstance(island, Mapping) else None
            if not isinstance(entries, list):
                continue
            for entry in entries:
                key = entry.get("key") if isinstance(entry, Mapping) else None
                if isinstance(key, str) and key in entities and key not in seen:
                    entity = entities[key]
                    if isinstance(entity, Mapping):
                        seen.add(key)
                        ordered.append((key, entity))
    for key, entity in entities.items():
        if isinstance(key, str) and key not in seen and isinstance(entity, Mapping):
            seen.add(key)
            ordered.append((key, entity))
    return ordered


def turn_id_of(entity_key: str, entity: Mapping[str, Any]) -> str:
    turn_id = entity.get("turnId")
    if isinstance(turn_id, str) and turn_id:
        return turn_id
    return entity_key


def thread_snapshot_from_conversation_state(state: Mapping[str, Any]) -> dict[str, Any]:
    """Build an app-server style thread dict from an IPC conversation state."""

    turns: list[dict[str, Any]] = []
    for key, entity in turn_entities_in_order(state):
        turn_id = turn_id_of(key, entity)
        raw_items = entity.get("items")
        items: list[dict[str, Any]] = []
        if isinstance(raw_items, list):
            for raw in raw_items:
                if not isinstance(raw, Mapping):
                    continue
                item = dict(raw)
                item.setdefault("turnId", turn_id)
                items.append(item)
        turns.append(
            {
                "id": turn_id,
                "status": entity.get("status"),
                "items": items,
                **({"error": entity["error"]} if entity.get("error") else {}),
            }
        )
    if not turns:
        legacy = state.get("turns")
        if isinstance(legacy, list):
            turns = [dict(turn) for turn in legacy if isinstance(turn, Mapping)]
    return {
        "id": state.get("id"),
        "cwd": state.get("cwd"),
        "name": state.get("title"),
        "status": state.get("threadRuntimeStatus"),
        "turns": turns,
    }


def active_turn_id(state: Mapping[str, Any]) -> str | None:
    """Return the id of the turn still in progress, if any."""

    for key, entity in reversed(turn_entities_in_order(state)):
        status = entity.get("status")
        if status in TERMINAL_TURN_STATUSES:
            return None
        return turn_id_of(key, entity)
    return None


def touches_turn_history(patches: tuple[Mapping[str, Any], ...]) -> bool:
    for patch in patches:
        path = patch.get("path")
        if isinstance(path, (list, tuple)) and path and path[0] in {"turnHistory", "turns"}:
            return True
    return False
