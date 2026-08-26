from __future__ import annotations

import asyncio
from typing import Any

from connector.server.notification_coalescer import (
    TimelineItemNotificationCoalescer,
)


def test_coalescer_sends_only_latest_assistant_message_per_window() -> None:
    asyncio.run(_exercise_window_coalescing())


def test_coalescer_flushes_assistant_message_before_turn_end() -> None:
    asyncio.run(_exercise_turn_end_barrier())


def test_coalescer_sends_non_assistant_timeline_items_immediately() -> None:
    asyncio.run(_exercise_immediate_tool_item())


async def _exercise_window_coalescing() -> None:
    sent: list[tuple[str, dict[str, Any]]] = []

    async def sender(method: str, params: dict[str, Any]) -> None:
        sent.append((method, params))

    coalescer = TimelineItemNotificationCoalescer(sender, window_seconds=0.01)
    await coalescer.send("timeline.itemUpsert", _assistant_message(1, "hel"))
    await coalescer.send("timeline.itemUpsert", _assistant_message(2, "hello"))

    assert sent == []
    await asyncio.sleep(0.02)

    assert len(sent) == 1
    assert sent[0][1]["item"]["revision"] == 2
    assert sent[0][1]["item"]["content"]["text"] == "hello"
    await coalescer.close()


async def _exercise_turn_end_barrier() -> None:
    sent: list[tuple[str, dict[str, Any]]] = []

    async def sender(method: str, params: dict[str, Any]) -> None:
        sent.append((method, params))

    coalescer = TimelineItemNotificationCoalescer(sender, window_seconds=10)
    await coalescer.send("timeline.itemUpsert", _assistant_message(1, "hel"))
    await coalescer.send("timeline.itemUpsert", _assistant_message(2, "hello"))
    await coalescer.send(
        "session.turnEnded",
        {"sessionId": "sess_1", "outcome": "completed"},
    )

    assert [method for method, _params in sent] == [
        "timeline.itemUpsert",
        "session.turnEnded",
    ]
    assert sent[0][1]["item"]["revision"] == 2
    await coalescer.close()


async def _exercise_immediate_tool_item() -> None:
    sent: list[tuple[str, dict[str, Any]]] = []

    async def sender(method: str, params: dict[str, Any]) -> None:
        sent.append((method, params))

    coalescer = TimelineItemNotificationCoalescer(sender, window_seconds=10)
    await coalescer.send(
        "timeline.itemUpsert",
        {
            "sessionId": "sess_1",
            "item": {"id": "tool_1", "type": "tool", "revision": 1},
        },
    )

    assert [method for method, _params in sent] == ["timeline.itemUpsert"]
    await coalescer.close()


def _assistant_message(revision: int, text: str) -> dict[str, Any]:
    return {
        "sessionId": "sess_1",
        "item": {
            "id": "message_1",
            "type": "message",
            "role": "assistant",
            "revision": revision,
            "content": {"text": text},
        },
    }
