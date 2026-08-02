from __future__ import annotations

import asyncio
from typing import Any

from connector._reference.codex.ipc_protocol import CodexIpcFollowingChangedBroadcast
from connector._reference.codex.ipc_publisher import (
    CodexIpcPublisher,
    codex_ipc_conversation_from_thread,
)


class FakeSender:
    def __init__(self) -> None:
        self.broadcasts: list[dict[str, Any]] = []

    async def send_broadcast(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        version: int | None = None,
        target_client_ids: list[str] | None = None,
    ) -> bool:
        self.broadcasts.append(
            {
                "method": method,
                "params": params,
                "version": version,
                "targetClientIds": target_client_ids,
            }
        )
        return True


def _thread() -> dict[str, Any]:
    return {
        "id": "thr_1",
        "title": "Local thread",
        "cwd": "/repo",
        "status": {"type": "active"},
        "turns": [
            {
                "id": "turn_1",
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
        ],
    }


def _following(*, following: bool = True) -> CodexIpcFollowingChangedBroadcast:
    return CodexIpcFollowingChangedBroadcast.model_validate(
        {
            "sourceClientId": "follower_1",
            "params": {
                "conversationId": "thr_1",
                "hostId": "local",
                "following": following,
            },
        }
    )


def test_thread_snapshot_projects_canonical_history() -> None:
    state = codex_ipc_conversation_from_thread(
        _thread(),
        fallback_thread_id="fallback",
    )

    assert state.id == "thr_1"
    assert state.turns == []
    assert state.turnHistory is not None
    history = state.turnHistory.history
    assert history.isComplete is True
    assert history.islands[0].entries[0].value == "turn_1"
    assert history.entitiesByKey["turn_1"].items[0].model_extra["text"] == "hel"


def test_active_owner_sends_targeted_snapshot_to_late_follower() -> None:
    async def exercise() -> None:
        sender = FakeSender()
        publisher = CodexIpcPublisher(sender)
        await publisher.load_thread(
            _thread(),
            fallback_thread_id="thr_1",
            activate=True,
        )
        assert sender.broadcasts == []

        await publisher.handle_following(_following())

        assert len(sender.broadcasts) == 1
        broadcast = sender.broadcasts[0]
        assert broadcast["method"] == "thread-stream-state-changed"
        assert broadcast["targetClientIds"] == ["follower_1"]
        assert broadcast["params"]["change"]["type"] == "snapshot"
        assert broadcast["params"]["change"]["revision"] == 0

    asyncio.run(exercise())


def test_passive_notification_does_not_claim_thread_ownership() -> None:
    async def exercise() -> None:
        sender = FakeSender()
        publisher = CodexIpcPublisher(sender)
        await publisher.load_thread(_thread(), fallback_thread_id="thr_1")
        await publisher.handle_following(_following())
        assert sender.broadcasts == []

        handled = await publisher.handle_notification(
            {
                "method": "turn/started",
                "params": {
                    "threadId": "thr_1",
                    "turnId": "turn_2",
                    "turn": {"id": "turn_2", "status": "inProgress"},
                },
            }
        )

        assert handled is False
        assert sender.broadcasts == []
        owned = publisher.get("thr_1")
        assert owned is not None
        assert owned.active is False

    asyncio.run(exercise())


def test_agent_deltas_publish_full_text_replacements_in_revision_order() -> None:
    async def exercise() -> None:
        sender = FakeSender()
        publisher = CodexIpcPublisher(sender)
        await publisher.load_thread(
            _thread(),
            fallback_thread_id="thr_1",
            activate=True,
        )
        await publisher.handle_following(_following())
        sender.broadcasts.clear()

        for delta in ("lo", "!"):
            handled = await publisher.handle_notification(
                {
                    "method": "item/agentMessage/delta",
                    "params": {
                        "threadId": "thr_1",
                        "turnId": "turn_1",
                        "itemId": "msg_1",
                        "delta": delta,
                    },
                }
            )
            assert handled is True

        assert len(sender.broadcasts) == 2
        first = sender.broadcasts[0]["params"]["change"]
        second = sender.broadcasts[1]["params"]["change"]
        assert (first["baseRevision"], first["revision"]) == (0, 1)
        assert (second["baseRevision"], second["revision"]) == (1, 2)
        assert first["patches"][0]["value"] == "hello"
        assert second["patches"][0]["value"] == "hello!"
        assert first["patches"][0]["path"][-1] == "text"
        assert sender.broadcasts[0]["targetClientIds"] == ["follower_1"]

    asyncio.run(exercise())


def test_unfollow_stops_incremental_broadcasts_but_retains_owner_state() -> None:
    async def exercise() -> None:
        sender = FakeSender()
        publisher = CodexIpcPublisher(sender)
        await publisher.load_thread(
            _thread(),
            fallback_thread_id="thr_1",
            activate=True,
        )
        await publisher.handle_following(_following())
        await publisher.handle_following(_following(following=False))
        sender.broadcasts.clear()

        await publisher.handle_notification(
            {
                "method": "item/agentMessage/delta",
                "params": {
                    "threadId": "thr_1",
                    "turnId": "turn_1",
                    "itemId": "msg_1",
                    "delta": "lo",
                },
            }
        )

        assert sender.broadcasts == []
        owned = publisher.get("thr_1")
        assert owned is not None
        assert owned.revision == 1
        assert owned.state.turnHistory is not None
        item = owned.state.turnHistory.history.entitiesByKey["turn_1"].items[0]
        assert item.model_extra["text"] == "hello"

    asyncio.run(exercise())


def test_unknown_owned_event_requests_snapshot_refresh() -> None:
    async def exercise() -> None:
        sender = FakeSender()
        publisher = CodexIpcPublisher(sender)
        await publisher.load_thread(_thread(), fallback_thread_id="thr_1")
        await publisher.handle_following(_following())
        await publisher.activate("thr_1")

        handled = await publisher.handle_notification(
            {
                "method": "item/reasoning/textDelta",
                "params": {
                    "threadId": "thr_1",
                    "turnId": "turn_1",
                    "itemId": "reasoning_1",
                    "delta": "thinking",
                },
            }
        )

        assert handled is False
        owned = publisher.get("thr_1")
        assert owned is not None
        assert owned.active is True
        assert len(sender.broadcasts) == 1
        assert sender.broadcasts[0]["params"]["change"]["type"] == "snapshot"
        assert sender.broadcasts[0]["params"]["change"]["revision"] == 0

    asyncio.run(exercise())
