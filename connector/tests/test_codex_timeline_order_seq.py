"""Regression tests for 1-based Codex timeline positions.

The Codex runtime used to number timeline items from 0. Older clients (Android
builds before 2.2.0, i.e. before #639) treat ``orderSeq = 0`` as "unassigned"
and move that item after every known item, which shows each reply above the
question it answers (#568, #838). The Claude runtime already numbers from 1,
so the Codex runtime emits 1-based positions too. Clients that sort strictly
ascending and accept any position > 0 keep working unchanged.
"""

from __future__ import annotations

from openai_codex.models import Notification, ReasoningTextDeltaNotification

from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator


def _reasoning_delta(item_id: str, turn_id: str) -> CodexSdkEvent:
    return CodexSdkEvent.from_value(
        Notification(
            method="item/reasoning/textDelta",
            payload=ReasoningTextDeltaNotification(
                contentIndex=0,
                delta="thinking",
                itemId=item_id,
                threadId="thread_1",
                turnId=turn_id,
            ),
        )
    )


def test_live_events_number_timeline_items_from_one() -> None:
    accumulator = CodexTimelineAccumulator()

    first = accumulator.item_from_event(
        session_id="sess_1",
        external_session_id="thread_1",
        event=_reasoning_delta("item_first", "turn_1"),
    )
    second = accumulator.item_from_event(
        session_id="sess_1",
        external_session_id="thread_1",
        event=_reasoning_delta("item_second", "turn_2"),
    )

    assert first is not None
    assert second is not None
    assert first.id != second.id
    assert [first.order_seq, second.order_seq] == [1, 2]


def test_thread_snapshot_numbers_timeline_items_from_one() -> None:
    accumulator = CodexTimelineAccumulator()

    items = accumulator.items_from_thread_snapshot(
        session_id="sess_1",
        external_session_id="thread_1",
        thread={
            "turns": [
                {
                    "id": "turn_1",
                    "items": [
                        {
                            "id": "item-question",
                            "type": "userMessage",
                            "status": "completed",
                            "text": "question",
                        },
                        {
                            "id": "item-answer",
                            "type": "agentMessage",
                            "status": "completed",
                            "text": "answer",
                        },
                    ],
                }
            ]
        },
        limit=None,
    )

    assert [item.order_seq for item in items] == [1, 2]
