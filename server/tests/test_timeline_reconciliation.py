from __future__ import annotations

from agent_server.core.models import TimelineItem, TimelineItemIn
from agent_server.infra.repositories.store_support import _should_keep_existing_timeline_item


def test_message_attachment_echo_does_not_win_by_longer_text() -> None:
    existing = TimelineItem(
        id="item_1",
        sessionId="sess_1",
        turnId="turn_1",
        type="message",
        status="done",
        role="user",
        content={
            "text": (
                "这是什么文件\n\n"
                "Attached file: timeline.json Path: /tmp/timeline.json Media type: application/json\n\n"
                "File content: {\"items\": [\"large historical payload\"]}"
            ),
            "format": "markdown",
        },
        source={
            "runtime": "codex",
            "sessionId": "thread_1",
            "turnId": "turn_1",
            "itemId": "item_1",
            "itemType": "userMessage",
        },
        orderSeq=1,
        revision=1,
        contentHash="sha256:old",
        updatedSeq=1,
        createdAt="2026-08-07T00:00:00Z",
        updatedAt="2026-08-07T00:00:00Z",
    )
    incoming = TimelineItemIn(
        id="item_1",
        sessionId="sess_1",
        turnId="turn_1",
        type="message",
        status="done",
        role="user",
        content={
            "text": "这是什么文件",
            "format": "markdown",
            "attachments": [{"fileId": "file_1", "name": "timeline.json"}],
        },
        source={
            "runtime": "codex",
            "sessionId": "thread_1",
            "turnId": "turn_1",
            "itemId": "item_1",
            "itemType": "userMessage",
        },
        orderSeq=1,
        revision=2,
        contentHash="sha256:new",
    )

    assert _should_keep_existing_timeline_item(existing, incoming) is False
