from __future__ import annotations

import asyncio

import pytest

from connector.codex.ipc_protocol import CodexIpcStreamStateChangedBroadcast
from connector.codex.ipc_state import (
    CodexIpcOwnerError,
    CodexIpcPatchError,
    CodexIpcRevisionError,
    CodexIpcStateRegistry,
    codex_ipc_thread_snapshot,
)


def _conversation_state() -> dict:
    return {
        "id": "thr_1",
        "hostId": "local",
        "title": "IPC thread",
        "cwd": "/repo",
        "threadRuntimeStatus": {"type": "active"},
        "turns": [],
        "turnHistory": {
            "kind": "canonical",
            "history": {
                "generation": 1,
                "isComplete": True,
                "entitiesByKey": {
                    "turn_key": {
                        "turnId": "turn_1",
                        "status": "inProgress",
                        "items": [
                            {
                                "id": "msg_1",
                                "type": "agentMessage",
                                "status": "inProgress",
                                "text": "hel",
                            }
                        ],
                    }
                },
                "islands": [
                    {
                        "id": "tail:1",
                        "entries": [{"key": "turn_key", "value": "turn_key"}],
                    }
                ],
            },
        },
    }


def _stream_message(
    change: dict,
    *,
    source_client_id: str = "owner_1",
) -> CodexIpcStreamStateChangedBroadcast:
    return CodexIpcStreamStateChangedBroadcast.model_validate(
        {
            "sourceClientId": source_client_id,
            "params": {
                "conversationId": "thr_1",
                "hostId": "local",
                "change": change,
            },
        }
    )


async def _apply_snapshot(
    registry: CodexIpcStateRegistry,
    *,
    revision: int = 3,
) -> None:
    await registry.apply(
        _stream_message(
            {
                "type": "snapshot",
                "revision": revision,
                "conversationState": _conversation_state(),
            }
        )
    )


def test_snapshot_flattens_canonical_history_in_island_order() -> None:
    async def exercise() -> None:
        registry = CodexIpcStateRegistry()
        await _apply_snapshot(registry)

        state = registry.get("thr_1")
        assert state is not None
        thread = codex_ipc_thread_snapshot(state.conversation_state)
        assert thread["id"] == "thr_1"
        assert thread["turns"][0]["turnId"] == "turn_1"
        assert thread["turns"][0]["items"][0]["text"] == "hel"

    asyncio.run(exercise())


def test_patch_applies_atomically_and_reports_changed_item() -> None:
    async def exercise() -> None:
        registry = CodexIpcStateRegistry()
        await _apply_snapshot(registry)
        applied = await registry.apply(
            _stream_message(
                {
                    "type": "patches",
                    "baseRevision": 3,
                    "revision": 4,
                    "patches": [
                        {
                            "op": "replace",
                            "path": [
                                "turnHistory",
                                "history",
                                "entitiesByKey",
                                "turn_key",
                                "items",
                                0,
                                "text",
                            ],
                            "value": "hello",
                        }
                    ],
                }
            )
        )

        assert applied.thread_state.revision == 4
        assert applied.patch_scope.item_indexes_by_entity == {
            "turn_key": frozenset({0})
        }
        assert not applied.patch_scope.requires_timeline_sync
        item = applied.thread_state.conversation_state.turnHistory
        assert item is not None
        assert (
            item.history.entitiesByKey["turn_key"].items[0].model_extra["text"]
            == "hello"
        )

    asyncio.run(exercise())


def test_revision_gap_and_owner_change_leave_snapshot_unchanged() -> None:
    async def exercise() -> None:
        registry = CodexIpcStateRegistry()
        await _apply_snapshot(registry)
        gap = _stream_message(
            {
                "type": "patches",
                "baseRevision": 4,
                "revision": 5,
                "patches": [],
            }
        )
        with pytest.raises(CodexIpcRevisionError):
            await registry.apply(gap)

        other_owner = _stream_message(
            {
                "type": "patches",
                "baseRevision": 3,
                "revision": 4,
                "patches": [],
            },
            source_client_id="owner_2",
        )
        with pytest.raises(CodexIpcOwnerError):
            await registry.apply(other_owner)

        state = registry.get("thr_1")
        assert state is not None
        assert state.revision == 3
        assert state.owner_client_id == "owner_1"

    asyncio.run(exercise())


def test_invalid_patch_does_not_partially_commit() -> None:
    async def exercise() -> None:
        registry = CodexIpcStateRegistry()
        await _apply_snapshot(registry)
        invalid = _stream_message(
            {
                "type": "patches",
                "baseRevision": 3,
                "revision": 4,
                "patches": [
                    {"op": "replace", "path": ["title"], "value": "changed"},
                    {
                        "op": "replace",
                        "path": ["missing", "value"],
                        "value": "invalid",
                    },
                ],
            }
        )
        with pytest.raises(CodexIpcPatchError):
            await registry.apply(invalid)

        state = registry.get("thr_1")
        assert state is not None
        assert state.revision == 3
        assert state.conversation_state.title == "IPC thread"

    asyncio.run(exercise())


def test_item_removal_requires_authoritative_timeline_sync() -> None:
    async def exercise() -> None:
        registry = CodexIpcStateRegistry()
        await _apply_snapshot(registry)
        applied = await registry.apply(
            _stream_message(
                {
                    "type": "patches",
                    "baseRevision": 3,
                    "revision": 4,
                    "patches": [
                        {
                            "op": "remove",
                            "path": [
                                "turnHistory",
                                "history",
                                "entitiesByKey",
                                "turn_key",
                                "items",
                                0,
                            ],
                        }
                    ],
                }
            )
        )
        assert applied.patch_scope.requires_timeline_sync

    asyncio.run(exercise())


def test_item_insertion_reports_new_item_without_timeline_sync() -> None:
    async def exercise() -> None:
        registry = CodexIpcStateRegistry()
        await _apply_snapshot(registry)
        applied = await registry.apply(
            _stream_message(
                {
                    "type": "patches",
                    "baseRevision": 3,
                    "revision": 4,
                    "patches": [
                        {
                            "op": "add",
                            "path": [
                                "turnHistory",
                                "history",
                                "entitiesByKey",
                                "turn_key",
                                "items",
                                1,
                            ],
                            "value": {
                                "id": "msg_2",
                                "type": "agentMessage",
                                "text": "next",
                            },
                        }
                    ],
                }
            )
        )
        assert applied.patch_scope.item_indexes_by_entity == {
            "turn_key": frozenset({1})
        }
        assert not applied.patch_scope.requires_timeline_sync

    asyncio.run(exercise())


def test_ephemeral_turn_and_history_patches_do_not_require_timeline_sync() -> None:
    async def exercise() -> None:
        registry = CodexIpcStateRegistry()
        await _apply_snapshot(registry)
        applied = await registry.apply(
            _stream_message(
                {
                    "type": "patches",
                    "baseRevision": 3,
                    "revision": 4,
                    "patches": [
                        {
                            "op": "replace",
                            "path": [
                                "turnHistory",
                                "history",
                                "entitiesByKey",
                                "turn_key",
                                "durationMs",
                            ],
                            "value": 1250,
                        },
                        {
                            "op": "replace",
                            "path": ["turnHistory", "history", "generation"],
                            "value": 2,
                        },
                        {
                            "op": "replace",
                            "path": ["turnHistory", "history", "isComplete"],
                            "value": False,
                        },
                        {
                            "op": "replace",
                            "path": [
                                "turnHistory",
                                "history",
                                "islands",
                                0,
                                "id",
                            ],
                            "value": "tail:2",
                        },
                    ],
                }
            )
        )

        assert applied.patch_scope.item_indexes_by_entity == {}
        assert not applied.patch_scope.metadata_changed
        assert not applied.patch_scope.requires_timeline_sync

    asyncio.run(exercise())
