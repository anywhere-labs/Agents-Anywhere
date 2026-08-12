from __future__ import annotations

from agent_server.core.models import TimelineItem, TimelineItemIn
from agent_server.infra.repositories.store_support import (
    _dedupe_legacy_history_items,
    _should_keep_existing_timeline_item,
)


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


def test_derived_key_duplicate_keeps_completed_message() -> None:
    running = TimelineItem(
        id="msg_started",
        sessionId="sess_1",
        turnId="turn_1",
        type="message",
        status="running",
        role="assistant",
        content={"text": "", "format": "markdown", "kind": "markdown"},
        source={
            "runtime": "codex",
            "sessionId": "thread_1",
            "turnId": "turn_1",
            "itemId": "msg_started",
            "itemType": "agentMessage",
            "derivedKey": "agentMessage-assistant-turn_1-0",
        },
        orderSeq=1,
        revision=1,
        contentHash="sha256:running",
        updatedSeq=1,
        createdAt="2026-08-07T00:00:00Z",
        updatedAt="2026-08-07T00:00:00Z",
    )
    completed = TimelineItem(
        id="msg_completed",
        sessionId="sess_1",
        turnId="turn_1",
        type="message",
        status="done",
        role="assistant",
        content={"text": "done", "format": "markdown", "kind": "markdown"},
        source={
            "runtime": "codex",
            "sessionId": "thread_1",
            "turnId": "turn_1",
            "itemId": "msg_completed",
            "itemType": "agentMessage",
            "derivedKey": "agentMessage-assistant-turn_1-0",
        },
        orderSeq=2,
        revision=1,
        contentHash="sha256:done",
        updatedSeq=2,
        createdAt="2026-08-07T00:00:00Z",
        updatedAt="2026-08-07T00:00:00Z",
    )

    assert _dedupe_legacy_history_items([running, completed]) == [completed]


def test_derived_key_duplicate_keeps_multiple_completed_assistant_messages() -> None:
    first = TimelineItem(
        id="msg_1",
        sessionId="sess_1",
        turnId="turn_1",
        type="message",
        status="done",
        role="assistant",
        content={"text": "first", "format": "markdown", "kind": "markdown"},
        source={
            "runtime": "codex",
            "sessionId": "thread_1",
            "turnId": "turn_1",
            "itemId": "msg_1",
            "itemType": "agentMessage",
            "derivedKey": "agentMessage-assistant-turn_1-0",
        },
        orderSeq=1,
        revision=1,
        contentHash="sha256:first",
        updatedSeq=1,
        createdAt="2026-08-07T00:00:00Z",
        updatedAt="2026-08-07T00:00:00Z",
    )
    second = TimelineItem(
        id="msg_2",
        sessionId="sess_1",
        turnId="turn_1",
        type="message",
        status="done",
        role="assistant",
        content={"text": "second", "format": "markdown", "kind": "markdown"},
        source={
            "runtime": "codex",
            "sessionId": "thread_1",
            "turnId": "turn_1",
            "itemId": "msg_2",
            "itemType": "agentMessage",
            "derivedKey": "agentMessage-assistant-turn_1-0",
        },
        orderSeq=2,
        revision=1,
        contentHash="sha256:second",
        updatedSeq=2,
        createdAt="2026-08-07T00:00:00Z",
        updatedAt="2026-08-07T00:00:00Z",
    )

    assert _dedupe_legacy_history_items([first, second]) == [first, second]


def test_thread_read_echo_with_matching_client_message_id_is_ignored() -> None:
    live = TimelineItem(
        id="live_user_item",
        sessionId="sess_1",
        turnId="turn_1",
        type="message",
        status="done",
        role="user",
        content={"text": "read this", "format": "markdown"},
        source={
            "runtime": "codex",
            "sessionId": "thread_1",
            "turnId": "turn_1",
            "itemId": "live_user_item",
            "itemType": "userMessage",
            "event": "item/completed",
            "clientMessageId": "cm_file_1",
        },
        orderSeq=1,
        revision=1,
        contentHash="sha256:live",
        updatedSeq=1,
        createdAt="2026-08-07T00:00:00Z",
        updatedAt="2026-08-07T00:00:00Z",
    )
    snapshot = TimelineItem(
        id="item-1",
        sessionId="sess_1",
        turnId="turn_1",
        type="message",
        status="done",
        role="user",
        content={
            "text": "read this\n\n[Attached file: note.txt (text/plain, 16 bytes) at /tmp/file_1-note.txt]",
            "format": "markdown",
            "attachments": [{"fileId": "file_1", "name": "note.txt"}],
        },
        source={
            "runtime": "codex",
            "sessionId": "thread_1",
            "turnId": "turn_1",
            "itemId": "item-1",
            "itemType": "userMessage",
            "event": "thread/read",
            "clientMessageId": "cm_file_1",
        },
        orderSeq=2,
        revision=1,
        contentHash="sha256:snapshot",
        updatedSeq=2,
        createdAt="2026-08-07T00:00:00Z",
        updatedAt="2026-08-07T00:00:00Z",
    )

    assert _dedupe_legacy_history_items([live, snapshot]) == [live]
