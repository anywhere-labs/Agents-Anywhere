from __future__ import annotations

import asyncio
import copy
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import ValidationError

from connector.codex.ipc_protocol import (
    CodexIpcAddPatch,
    CodexIpcConversationState,
    CodexIpcPatch,
    CodexIpcPatchesChange,
    CodexIpcRemovePatch,
    CodexIpcReplacePatch,
    CodexIpcSnapshotChange,
    CodexIpcStreamStateChangedBroadcast,
)


class CodexIpcStateError(RuntimeError):
    pass


class CodexIpcRevisionError(CodexIpcStateError):
    pass


class CodexIpcOwnerError(CodexIpcStateError):
    pass


class CodexIpcPatchError(CodexIpcStateError):
    pass


@dataclass(slots=True)
class CodexIpcThreadState:
    conversation_id: str
    owner_client_id: str
    revision: int
    conversation_state: CodexIpcConversationState


@dataclass(frozen=True, slots=True)
class CodexIpcPatchScope:
    item_indexes_by_entity: dict[str, frozenset[int]] = field(default_factory=dict)
    metadata_changed: bool = False
    requires_timeline_sync: bool = False


@dataclass(frozen=True, slots=True)
class CodexIpcAppliedState:
    kind: Literal["snapshot", "patches"]
    thread_state: CodexIpcThreadState
    patch_scope: CodexIpcPatchScope


class CodexIpcStateRegistry:
    def __init__(self) -> None:
        self._states: dict[str, CodexIpcThreadState] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def get(self, conversation_id: str) -> CodexIpcThreadState | None:
        return self._states.get(conversation_id)

    def reset(self) -> None:
        self._states.clear()

    def discard(self, conversation_id: str) -> None:
        self._states.pop(conversation_id, None)

    def remove_owner(self, client_id: str) -> list[str]:
        removed = [
            conversation_id
            for conversation_id, state in self._states.items()
            if state.owner_client_id == client_id
        ]
        for conversation_id in removed:
            self._states.pop(conversation_id, None)
        return removed

    async def apply(
        self,
        message: CodexIpcStreamStateChangedBroadcast,
    ) -> CodexIpcAppliedState:
        conversation_id = message.params.conversationId
        lock = self._locks.setdefault(conversation_id, asyncio.Lock())
        async with lock:
            change = message.params.change
            if isinstance(change, CodexIpcSnapshotChange):
                thread_state = CodexIpcThreadState(
                    conversation_id=conversation_id,
                    owner_client_id=message.sourceClientId,
                    revision=change.revision,
                    conversation_state=change.conversationState.model_copy(deep=True),
                )
                self._states[conversation_id] = thread_state
                return CodexIpcAppliedState(
                    kind="snapshot",
                    thread_state=thread_state,
                    patch_scope=CodexIpcPatchScope(requires_timeline_sync=True),
                )

            current = self._states.get(conversation_id)
            if current is None:
                raise CodexIpcRevisionError(
                    f"patch received before snapshot for conversation {conversation_id}"
                )
            if current.owner_client_id != message.sourceClientId:
                raise CodexIpcOwnerError(
                    f"patch owner changed for conversation {conversation_id}"
                )
            if change.baseRevision != current.revision:
                raise CodexIpcRevisionError(
                    f"patch base revision {change.baseRevision} does not match {current.revision}"
                )

            candidate = copy.deepcopy(
                current.conversation_state.model_dump(mode="python")
            )
            try:
                for patch in change.patches:
                    candidate = _apply_patch(candidate, patch)
                conversation_state = CodexIpcConversationState.model_validate(candidate)
            except (CodexIpcPatchError, ValidationError) as exc:
                raise CodexIpcPatchError(
                    f"failed to apply patches for conversation {conversation_id}"
                ) from exc

            thread_state = CodexIpcThreadState(
                conversation_id=conversation_id,
                owner_client_id=current.owner_client_id,
                revision=change.revision,
                conversation_state=conversation_state,
            )
            self._states[conversation_id] = thread_state
            return CodexIpcAppliedState(
                kind="patches",
                thread_state=thread_state,
                patch_scope=codex_ipc_patch_scope(change),
            )


def codex_ipc_thread_snapshot(state: CodexIpcConversationState) -> dict[str, Any]:
    turns: list[dict[str, Any]] = []
    history = state.turnHistory.history if state.turnHistory is not None else None
    if history is not None:
        seen: set[str] = set()
        for island in history.islands:
            for entry in island.entries:
                entity_key = (
                    entry.value if entry.value in history.entitiesByKey else entry.key
                )
                turn = history.entitiesByKey.get(entity_key)
                if turn is None or entity_key in seen:
                    continue
                seen.add(entity_key)
                turns.append(turn.model_dump(mode="python"))
        for entity_key, turn in history.entitiesByKey.items():
            if entity_key not in seen:
                turns.append(turn.model_dump(mode="python"))
    elif state.turns:
        turns = [turn.model_dump(mode="python") for turn in state.turns]

    raw_state = state.model_dump(mode="python")
    snapshot = {
        "id": state.id,
        "title": state.title,
        "cwd": state.cwd,
        "status": state.threadRuntimeStatus,
        "model": state.latestModel,
        "reasoningEffort": state.latestReasoningEffort,
        "turns": turns,
    }
    for key in (
        "approvalPolicy",
        "sandbox",
        "sandboxPolicy",
        "settings",
        "threadSettings",
        "turnStartParams",
        "latestTurnStartParams",
    ):
        value = raw_state.get(key)
        if value is not None:
            snapshot[key] = value
    return snapshot


def codex_ipc_active_turn_id(state: CodexIpcConversationState) -> str | None:
    """Return the newest turn that Codex still reports as active."""

    turns = codex_ipc_thread_snapshot(state)["turns"]
    for turn in reversed(turns):
        if not isinstance(turn, dict):
            continue
        status = turn.get("status")
        if isinstance(status, dict):
            status = status.get("type") or status.get("status")
        if not isinstance(status, str):
            continue
        normalized = status.replace("_", "").replace("-", "").lower()
        if normalized in {"active", "inprogress", "pending", "running", "started"}:
            turn_id = turn.get("turnId") or turn.get("id")
            if isinstance(turn_id, str) and turn_id:
                return turn_id
    return None


def codex_ipc_patch_scope(change: CodexIpcPatchesChange) -> CodexIpcPatchScope:
    item_indexes: dict[str, set[int]] = {}
    metadata_changed = False
    requires_timeline_sync = False
    metadata_fields = {
        "title",
        "cwd",
        "threadRuntimeStatus",
        "latestModel",
        "latestReasoningEffort",
        "updatedAt",
        "recencyAt",
        "resumeState",
    }
    turn_timing_fields = {
        "turnStartedAtMs",
        "firstTurnWorkItemStartedAtMs",
        "finalAssistantStartedAtMs",
        "durationMs",
    }

    for patch in change.patches:
        path = patch.path
        if not path:
            requires_timeline_sync = True
            metadata_changed = True
            continue
        if path[0] in metadata_fields:
            metadata_changed = True
            continue
        if path[:3] != ["turnHistory", "history", "entitiesByKey"]:
            if path[:3] == ["turnHistory", "history", "islands"]:
                continue
            if path[:3] == ["turnHistory", "history", "generation"]:
                continue
            if path[:3] == ["turnHistory", "history", "isComplete"]:
                continue
            if path[0] in {"turnHistory", "turns"}:
                requires_timeline_sync = True
            continue
        if len(path) < 4 or not isinstance(path[3], str):
            requires_timeline_sync = True
            continue
        entity_key = path[3]
        if len(path) >= 5 and path[4] in turn_timing_fields:
            continue
        if len(path) < 6 or path[4] != "items" or not isinstance(path[5], int):
            requires_timeline_sync = True
            continue
        if isinstance(patch, CodexIpcRemovePatch):
            requires_timeline_sync = True
            continue
        item_indexes.setdefault(entity_key, set()).add(path[5])

    return CodexIpcPatchScope(
        item_indexes_by_entity={
            entity_key: frozenset(indexes)
            for entity_key, indexes in item_indexes.items()
        },
        metadata_changed=metadata_changed,
        requires_timeline_sync=requires_timeline_sync,
    )


def _apply_patch(document: Any, patch: CodexIpcPatch) -> Any:
    path = list(patch.path)
    if not path:
        if isinstance(patch, CodexIpcRemovePatch):
            raise CodexIpcPatchError("cannot remove the conversation root")
        return copy.deepcopy(patch.value)

    parent = document
    for segment in path[:-1]:
        parent = _descend(parent, segment)
    final_segment = path[-1]

    if isinstance(parent, dict):
        if not isinstance(final_segment, str):
            raise CodexIpcPatchError("dictionary patch path requires a string key")
        if isinstance(patch, CodexIpcRemovePatch):
            if final_segment not in parent:
                raise CodexIpcPatchError("cannot remove a missing dictionary key")
            del parent[final_segment]
        elif isinstance(patch, CodexIpcReplacePatch):
            if final_segment not in parent:
                raise CodexIpcPatchError("cannot replace a missing dictionary key")
            parent[final_segment] = copy.deepcopy(patch.value)
        elif isinstance(patch, CodexIpcAddPatch):
            parent[final_segment] = copy.deepcopy(patch.value)
        return document

    if isinstance(parent, list):
        if not isinstance(final_segment, int):
            raise CodexIpcPatchError("list patch path requires an integer index")
        if isinstance(patch, CodexIpcAddPatch):
            if final_segment < 0 or final_segment > len(parent):
                raise CodexIpcPatchError("list add index is out of range")
            parent.insert(final_segment, copy.deepcopy(patch.value))
        elif isinstance(patch, CodexIpcReplacePatch):
            if final_segment < 0 or final_segment >= len(parent):
                raise CodexIpcPatchError("list replace index is out of range")
            parent[final_segment] = copy.deepcopy(patch.value)
        elif isinstance(patch, CodexIpcRemovePatch):
            if final_segment < 0 or final_segment >= len(parent):
                raise CodexIpcPatchError("list remove index is out of range")
            del parent[final_segment]
        return document

    raise CodexIpcPatchError("patch parent is not a container")


def _descend(value: Any, segment: str | int) -> Any:
    if isinstance(value, dict):
        if not isinstance(segment, str) or segment not in value:
            raise CodexIpcPatchError("patch path does not exist in dictionary")
        return value[segment]
    if isinstance(value, list):
        if not isinstance(segment, int) or segment < 0 or segment >= len(value):
            raise CodexIpcPatchError("patch path does not exist in list")
        return value[segment]
    raise CodexIpcPatchError("patch path crosses a non-container value")


__all__ = [
    "CodexIpcAppliedState",
    "CodexIpcOwnerError",
    "CodexIpcPatchError",
    "CodexIpcPatchScope",
    "CodexIpcRevisionError",
    "CodexIpcStateError",
    "CodexIpcStateRegistry",
    "CodexIpcThreadState",
    "codex_ipc_patch_scope",
    "codex_ipc_thread_snapshot",
]
