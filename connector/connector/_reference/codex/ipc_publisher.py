from __future__ import annotations

import asyncio
import copy
from dataclasses import dataclass
from typing import Any, Protocol

from connector._reference.codex.ipc_protocol import (
    CODEX_IPC_LOCAL_HOST_ID,
    CodexIpcConversationState,
    CodexIpcFollowingChangedBroadcast,
    CodexIpcPatchesChange,
    CodexIpcSnapshotChange,
    CodexIpcStreamStateParams,
)
from connector._reference.codex.ipc_state import codex_ipc_active_turn_id


class CodexIpcBroadcastSender(Protocol):
    async def send_broadcast(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        version: int | None = None,
        target_client_ids: list[str] | None = None,
    ) -> bool: ...


@dataclass(slots=True)
class CodexIpcOwnedThread:
    state: CodexIpcConversationState
    revision: int = 0
    active: bool = False


class CodexIpcPublisher:
    """Project locally owned app-server state to IPC followers."""

    def __init__(self, sender: CodexIpcBroadcastSender | None) -> None:
        self._sender = sender
        self._threads: dict[str, CodexIpcOwnedThread] = {}
        self._followers: dict[str, set[str]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def get(self, conversation_id: str) -> CodexIpcOwnedThread | None:
        return self._threads.get(conversation_id)

    def is_active(self, conversation_id: str) -> bool:
        current = self._threads.get(conversation_id)
        return current is not None and current.active

    def active_turn_id(self, conversation_id: str) -> str | None:
        current = self._threads.get(conversation_id)
        if current is None or not current.active:
            return None
        return codex_ipc_active_turn_id(current.state)

    def reset(self) -> None:
        self._threads.clear()
        self._followers.clear()

    def reset_connection(self) -> None:
        self._followers.clear()

    def remove_follower(self, client_id: str) -> None:
        for followers in self._followers.values():
            followers.discard(client_id)

    async def load_thread(
        self,
        thread: dict[str, Any],
        *,
        fallback_thread_id: str,
        activate: bool = False,
    ) -> None:
        conversation = codex_ipc_conversation_from_thread(
            thread,
            fallback_thread_id=fallback_thread_id,
        )
        lock = self._locks.setdefault(fallback_thread_id, asyncio.Lock())
        async with lock:
            current = self._threads.get(fallback_thread_id)
            if current is None:
                current = CodexIpcOwnedThread(
                    state=conversation,
                    active=activate,
                )
                self._threads[fallback_thread_id] = current
                if activate:
                    await self._send_snapshot_locked(fallback_thread_id, current)
                return

            was_active = current.active
            current.active = current.active or activate
            if current.state == conversation:
                if current.active and not was_active:
                    await self._send_snapshot_locked(fallback_thread_id, current)
                return
            current.state = conversation
            if current.active:
                current.revision += 1
                await self._send_snapshot_locked(fallback_thread_id, current)

    async def activate(self, conversation_id: str) -> None:
        lock = self._locks.setdefault(conversation_id, asyncio.Lock())
        async with lock:
            current = self._threads.get(conversation_id)
            if current is None:
                current = CodexIpcOwnedThread(
                    state=codex_ipc_conversation_from_thread(
                        {"id": conversation_id},
                        fallback_thread_id=conversation_id,
                    ),
                    active=True,
                )
                self._threads[conversation_id] = current
            elif current.active:
                return
            else:
                current.active = True
            await self._send_snapshot_locked(conversation_id, current)

    async def handle_following(
        self,
        message: CodexIpcFollowingChangedBroadcast,
    ) -> None:
        conversation_id = message.params.conversationId
        follower_id = message.sourceClientId
        lock = self._locks.setdefault(conversation_id, asyncio.Lock())
        async with lock:
            followers = self._followers.setdefault(conversation_id, set())
            if not message.params.following:
                followers.discard(follower_id)
                return
            followers.add(follower_id)
            current = self._threads.get(conversation_id)
            if current is not None and current.active:
                await self._send_snapshot_locked(
                    conversation_id,
                    current,
                    target_client_ids=[follower_id],
                )

    async def handle_notification(self, message: dict[str, Any]) -> bool:
        params = (
            message.get("params") if isinstance(message.get("params"), dict) else {}
        )
        conversation_id = _string(params.get("threadId")) or _nested_string(
            params, "thread", "id"
        )
        if conversation_id is None:
            return False

        lock = self._locks.setdefault(conversation_id, asyncio.Lock())
        async with lock:
            current = self._threads.get(conversation_id)
            if current is None or not current.active:
                return False
            projected = _project_notification(current.state, message)
            if projected is None:
                return False
            next_state, patches = projected
            if next_state == current.state:
                return True

            current.state = next_state
            current.revision += 1
            await self._send_patches_locked(conversation_id, current, patches)
            return True

    async def _send_snapshot_locked(
        self,
        conversation_id: str,
        current: CodexIpcOwnedThread,
        *,
        target_client_ids: list[str] | None = None,
    ) -> None:
        targets = target_client_ids or sorted(self._followers.get(conversation_id, ()))
        if self._sender is None or not targets:
            return
        params = CodexIpcStreamStateParams(
            conversationId=conversation_id,
            change=CodexIpcSnapshotChange(
                revision=current.revision,
                conversationState=current.state,
            ),
        )
        await self._sender.send_broadcast(
            "thread-stream-state-changed",
            params.model_dump(mode="json"),
            target_client_ids=targets,
        )

    async def _send_patches_locked(
        self,
        conversation_id: str,
        current: CodexIpcOwnedThread,
        patches: list[dict[str, Any]],
    ) -> None:
        targets = sorted(self._followers.get(conversation_id, ()))
        if self._sender is None or not targets:
            return
        change = CodexIpcPatchesChange.model_validate(
            {
                "baseRevision": current.revision - 1,
                "revision": current.revision,
                "patches": patches,
            }
        )
        params = CodexIpcStreamStateParams(
            conversationId=conversation_id,
            change=change,
        )
        await self._sender.send_broadcast(
            "thread-stream-state-changed",
            params.model_dump(mode="json"),
            target_client_ids=targets,
        )


def codex_ipc_conversation_from_thread(
    thread: dict[str, Any],
    *,
    fallback_thread_id: str,
) -> CodexIpcConversationState:
    conversation_id = _string(thread.get("id")) or fallback_thread_id
    entities: dict[str, dict[str, Any]] = {}
    entries: list[dict[str, str]] = []
    turns = thread.get("turns") if isinstance(thread.get("turns"), list) else []
    for index, raw_turn in enumerate(turns):
        if not isinstance(raw_turn, dict):
            continue
        turn = copy.deepcopy(raw_turn)
        turn_id = (
            _string(turn.get("turnId"))
            or _string(turn.get("id"))
            or f"local-turn-{index}"
        )
        turn["turnId"] = turn_id
        turn.pop("id", None)
        raw_items = turn.get("items") if isinstance(turn.get("items"), list) else []
        turn["items"] = [
            copy.deepcopy(item)
            for item in raw_items
            if isinstance(item, dict) and _string(item.get("type")) is not None
        ]
        entity_key = turn_id
        suffix = 1
        while entity_key in entities:
            suffix += 1
            entity_key = f"{turn_id}:{suffix}"
        entities[entity_key] = turn
        entries.append({"key": entity_key, "value": entity_key})

    payload: dict[str, Any] = {
        "id": conversation_id,
        "hostId": CODEX_IPC_LOCAL_HOST_ID,
        "title": thread.get("title") or thread.get("name"),
        "cwd": thread.get("cwd"),
        "threadRuntimeStatus": thread.get("threadRuntimeStatus", thread.get("status")),
        "createdAt": thread.get("createdAt"),
        "updatedAt": thread.get("updatedAt"),
        "ephemeral": bool(thread.get("ephemeral", False)),
        "turns": [],
        "turnHistory": {
            "kind": "canonical",
            "history": {
                "generation": 0,
                "isComplete": True,
                "entitiesByKey": entities,
                "islands": (
                    [{"id": "tail:local", "entries": entries}] if entries else []
                ),
            },
        },
    }
    return CodexIpcConversationState.model_validate(payload)


def _project_notification(
    state: CodexIpcConversationState,
    message: dict[str, Any],
) -> tuple[CodexIpcConversationState, list[dict[str, Any]]] | None:
    method = _string(message.get("method"))
    params = message.get("params") if isinstance(message.get("params"), dict) else {}
    document = copy.deepcopy(state.model_dump(mode="python"))
    patches: list[dict[str, Any]] = []

    if method == "thread/name/updated":
        title = params.get("threadName")
        _set_patch(document, ["title"], title, patches)
        return CodexIpcConversationState.model_validate(document), patches

    turn_id = _string(params.get("turnId")) or _nested_string(params, "turn", "id")
    if turn_id is None:
        return None
    turn_location = _find_turn(document, turn_id)

    if method == "turn/started":
        raw_turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        if turn_location is None:
            turn_location = _append_turn(document, turn_id, raw_turn, patches)
        path, turn = turn_location
        merged = {**turn, **copy.deepcopy(raw_turn), "turnId": turn_id}
        merged.pop("id", None)
        merged.setdefault("items", turn.get("items", []))
        merged.setdefault("status", "inProgress")
        _set_patch(document, path, merged, patches)
        _set_patch(document, ["threadRuntimeStatus"], {"type": "active"}, patches)
        return CodexIpcConversationState.model_validate(document), patches

    if turn_location is None:
        turn_location = _append_turn(document, turn_id, {}, patches)
    turn_path, turn = turn_location

    if method in {"item/started", "item/completed"}:
        raw_item = (
            params.get("item") if isinstance(params.get("item"), dict) else params
        )
        item = copy.deepcopy(raw_item)
        item_id = _string(item.get("id")) or _string(params.get("itemId"))
        item_type = _string(item.get("type"))
        if item_id is None or item_type is None:
            return None
        item["id"] = item_id
        _upsert_item(document, turn_path, turn, item_id, item, patches)
        return CodexIpcConversationState.model_validate(document), patches

    if method == "item/agentMessage/delta":
        item_id = _string(params.get("itemId")) or _nested_string(params, "item", "id")
        if item_id is None:
            return None
        delta = _string(params.get("delta")) or _string(params.get("text")) or ""
        item_location = _find_item(turn, item_id)
        if item_location is None:
            item = {
                "id": item_id,
                "type": "agentMessage",
                "status": "inProgress",
                "text": delta,
            }
            _upsert_item(document, turn_path, turn, item_id, item, patches)
        else:
            item_index, item = item_location
            text = _string(item.get("text")) or ""
            _set_patch(
                document,
                [*turn_path, "items", item_index, "text"],
                text + delta,
                patches,
            )
        return CodexIpcConversationState.model_validate(document), patches

    if method == "item/commandExecution/outputDelta":
        item_id = _string(params.get("itemId")) or _nested_string(params, "item", "id")
        if item_id is None:
            return None
        delta = _string(params.get("delta")) or _string(params.get("text")) or ""
        item_location = _find_item(turn, item_id)
        if item_location is None:
            item = {
                "id": item_id,
                "type": "commandExecution",
                "status": "inProgress",
                "aggregatedOutput": delta,
            }
            _upsert_item(document, turn_path, turn, item_id, item, patches)
        else:
            item_index, item = item_location
            output = _string(item.get("aggregatedOutput")) or ""
            _set_patch(
                document,
                [*turn_path, "items", item_index, "aggregatedOutput"],
                output + delta,
                patches,
            )
        return CodexIpcConversationState.model_validate(document), patches

    if method == "turn/diff/updated":
        _set_patch(
            document,
            [*turn_path, "diff"],
            _string(params.get("diff")) or _string(params.get("patch")) or "",
            patches,
        )
        return CodexIpcConversationState.model_validate(document), patches

    if method == "turn/completed":
        raw_turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        merged = {**turn, **copy.deepcopy(raw_turn), "turnId": turn_id}
        merged.pop("id", None)
        merged.setdefault("items", turn.get("items", []))
        merged.setdefault("status", "completed")
        _set_patch(document, turn_path, merged, patches)
        _set_patch(document, ["threadRuntimeStatus"], {"type": "idle"}, patches)
        return CodexIpcConversationState.model_validate(document), patches

    return None


def _append_turn(
    document: dict[str, Any],
    turn_id: str,
    raw_turn: dict[str, Any],
    patches: list[dict[str, Any]],
) -> tuple[list[str | int], dict[str, Any]]:
    history = document["turnHistory"]["history"]
    entity_key = turn_id
    suffix = 1
    while entity_key in history["entitiesByKey"]:
        suffix += 1
        entity_key = f"{turn_id}:{suffix}"
    turn = {**copy.deepcopy(raw_turn), "turnId": turn_id}
    turn.pop("id", None)
    turn.setdefault("items", [])
    entity_path: list[str | int] = [
        "turnHistory",
        "history",
        "entitiesByKey",
        entity_key,
    ]
    _set_patch(document, entity_path, turn, patches)
    islands = history["islands"]
    if not islands:
        _set_patch(
            document,
            ["turnHistory", "history", "islands", 0],
            {
                "id": "tail:local",
                "entries": [{"key": entity_key, "value": entity_key}],
            },
            patches,
        )
    else:
        entries = islands[-1]["entries"]
        _set_patch(
            document,
            [
                "turnHistory",
                "history",
                "islands",
                len(islands) - 1,
                "entries",
                len(entries),
            ],
            {"key": entity_key, "value": entity_key},
            patches,
        )
    return entity_path, turn


def _upsert_item(
    document: dict[str, Any],
    turn_path: list[str | int],
    turn: dict[str, Any],
    item_id: str,
    item: dict[str, Any],
    patches: list[dict[str, Any]],
) -> None:
    item_location = _find_item(turn, item_id)
    if item_location is None:
        index = len(turn.get("items", []))
    else:
        index = item_location[0]
    _set_patch(document, [*turn_path, "items", index], item, patches)


def _find_turn(
    document: dict[str, Any],
    turn_id: str,
) -> tuple[list[str | int], dict[str, Any]] | None:
    turn_history = document.get("turnHistory")
    if not isinstance(turn_history, dict):
        return None
    history = turn_history.get("history")
    if not isinstance(history, dict):
        return None
    entities = history.get("entitiesByKey")
    if not isinstance(entities, dict):
        return None
    for entity_key, turn in entities.items():
        if isinstance(turn, dict) and _string(turn.get("turnId")) == turn_id:
            return ["turnHistory", "history", "entitiesByKey", entity_key], turn
    return None


def _find_item(turn: dict[str, Any], item_id: str) -> tuple[int, dict[str, Any]] | None:
    items = turn.get("items") if isinstance(turn.get("items"), list) else []
    for index, item in enumerate(items):
        if isinstance(item, dict) and (
            _string(item.get("id")) == item_id or _string(item.get("itemId")) == item_id
        ):
            return index, item
    return None


def _set_patch(
    document: Any,
    path: list[str | int],
    value: Any,
    patches: list[dict[str, Any]],
) -> None:
    parent = document
    for segment in path[:-1]:
        parent = parent[segment]
    final = path[-1]
    if isinstance(parent, list):
        exists = isinstance(final, int) and 0 <= final < len(parent)
        if exists:
            parent[final] = copy.deepcopy(value)
            operation = "replace"
        elif isinstance(final, int) and final == len(parent):
            parent.append(copy.deepcopy(value))
            operation = "add"
        else:
            raise IndexError("IPC projection list path is out of range")
    else:
        exists = final in parent
        parent[final] = copy.deepcopy(value)
        operation = "replace" if exists else "add"
    patches.append({"op": operation, "path": path, "value": copy.deepcopy(value)})


def _nested_string(value: dict[str, Any], *path: str) -> str | None:
    current: Any = value
    for segment in path:
        if not isinstance(current, dict):
            return None
        current = current.get(segment)
    return _string(current)


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
