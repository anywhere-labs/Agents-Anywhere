from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

import pytest

from connector.runtimes.pi.projection import project_session
from connector.runtimes.pi.stream import PiStreamAccumulator


def message(role: str, content: Any, timestamp: int | None = 2, **kwargs: Any) -> dict:
    result = {"role": role, "content": content, **kwargs}
    if timestamp is not None:
        result["timestamp"] = timestamp
    return result


def entry(value: Mapping[str, Any], key: str) -> dict:
    return {"type": "message", "id": key, "message": dict(value)}


def update(kind: str, index: int, **kwargs: Any) -> dict:
    return {
        "type": "message_update",
        "assistantMessageEvent": {"type": kind, "contentIndex": index, **kwargs},
    }


async def user_turn(stream: PiStreamAccumulator, text: str = "hello", timestamp: int = 1) -> dict:
    user = message("user", text, timestamp)
    await stream.handle_event({"type": "message_start", "message": user})
    await stream.handle_event({"type": "message_end", "message": user})
    return user


def projected(*records: dict, **kwargs: Any) -> tuple:
    return project_session(
        list(records), session_id="s", external_session_id="/s.jsonl", **kwargs
    )


def output(items) -> list:
    """The run's own items; the user message that started it streams first."""

    return [item for item in items if item.role != "user"]


def assert_final_identity(stream: PiStreamAccumulator, final: tuple) -> None:
    final_by_id = {item.id: item for item in final}
    assert len(final_by_id) == len(final)
    for item in stream.items():
        expected = final_by_id[item.id]
        assert item.order_seq == expected.order_seq
        assert item.turn_id == expected.turn_id
        assert item.content == expected.content
        assert item.status == expected.status


async def test_delta_only_text_and_thinking_have_trailing_throttled_flush(fake_host) -> None:
    stream = PiStreamAccumulator(
        "s", "/s.jsonl", publish=fake_host.timeline_item_upsert, throttle_seconds=0.04
    )
    await user_turn(stream)
    await stream.handle_event({"type": "message_start", "message": message("assistant", [])})
    await stream.handle_event(update("thinking_delta", 0, delta="Think"))
    assert len(output(fake_host.timeline_items)) == 1
    await stream.handle_event(update("thinking_delta", 0, delta=" carefully"))
    await stream.handle_event(update("text_delta", 1, delta="Hello"))
    await stream.handle_event(update("text_delta", 1, delta=" world"))
    assert len(output(fake_host.timeline_items)) == 1
    await asyncio.sleep(0.08)
    published = output(fake_host.timeline_items)
    assert len(published) == 3
    assert [item.content["text"] for item in published] == [
        "Think",
        "Think carefully",
        "Hello world",
    ]
    assert all(item.status == "running" for item in published)
    first, second = published[:2]
    assert first.id == second.id
    assert second.revision > first.revision
    await stream.close()


async def test_message_end_flushes_authoritative_final_content_and_ids(fake_host) -> None:
    stream = PiStreamAccumulator(
        "s", "/s.jsonl", publish=fake_host.timeline_item_upsert, throttle_seconds=60
    )
    user = await user_turn(stream)
    await stream.handle_event({"type": "message_start", "message": message("assistant", [])})
    await stream.handle_event(update("text_delta", 0, delta="Helo"))
    await stream.handle_event(update("text_delta", 0, delta=" wor"))
    assert len(output(fake_host.timeline_items)) == 1
    await stream.handle_event(update("text_end", 0, content="Hello world"))
    final_message = message("assistant", [{"type": "text", "text": "Hello world!"}])
    await stream.handle_event({"type": "message_end", "message": final_message})
    assert len(output(fake_host.timeline_items)) == 2
    first, last = output(fake_host.timeline_items)
    assert first.id == last.id
    assert last.content["text"] == "Hello world!"
    assert last.status == "done"
    assert last.revision > first.revision
    final = projected(entry(user, "new-user-id"), entry(final_message, "assigned-after-stream"))
    assert_final_identity(stream, final)
    reconciled = stream.reconcile_snapshot(final)
    assert next(item for item in reconciled if item.id == last.id).revision >= last.revision
    await stream.close()


async def test_tool_lifecycle_and_mixed_blocks_match_final_projection(fake_host) -> None:
    stream = PiStreamAccumulator(
        "s", "/s.jsonl", publish=fake_host.timeline_item_upsert, throttle_seconds=0
    )
    user = await user_turn(stream)
    await stream.handle_event({"type": "message_start", "message": message("assistant", [])})
    await stream.handle_event(update("thinking_delta", 0, delta="Inspect first"))
    await stream.handle_event(update("text_delta", 1, delta="Running it"))
    await stream.handle_event(update("toolcall_start", 2, id="call-1", toolName="bash"))
    await stream.handle_event(update("toolcall_delta", 2, delta='{"command":'))
    await stream.handle_event(update("toolcall_delta", 2, delta='"pwd"}'))
    call = {"type": "toolCall", "id": "call-1", "name": "bash", "arguments": {"command": "pwd"}}
    await stream.handle_event(update("toolcall_end", 2, toolCall=call))
    await stream.handle_event(update("text_delta", 3, delta="Waiting"))
    assistant = message(
        "assistant",
        [
            {"type": "thinking", "thinking": "Inspect first"},
            {"type": "text", "text": "Running it"},
            call,
            {"type": "text", "text": "Waiting"},
        ],
        stopReason="toolUse",
    )
    await stream.handle_event({"type": "message_end", "message": assistant})
    await stream.handle_event(
        {
            "type": "tool_execution_start",
            "toolCallId": "call-1",
            "toolName": "bash",
            "args": {"command": "pwd"},
        }
    )
    for text in ("/", "/tmp/project"):
        await stream.handle_event(
            {
                "type": "tool_execution_update",
                "toolCallId": "call-1",
                "toolName": "bash",
                "partialResult": {"content": [{"type": "text", "text": text}]},
            }
        )
    tool_updates = [item for item in fake_host.timeline_items if item.type == "tool"]
    assert tool_updates[-1].content["output"] == "/tmp/project"
    assert tool_updates[-1].status == "running"
    result_content = [{"type": "text", "text": "permission denied"}]
    await stream.handle_event(
        {
            "type": "tool_execution_end",
            "toolCallId": "call-1",
            "toolName": "bash",
            "result": {"content": result_content, "details": {"exitCode": 1}},
            "isError": True,
        }
    )
    result = message(
        "toolResult",
        result_content,
        3,
        toolCallId="call-1",
        toolName="bash",
        details={"exitCode": 1},
        isError=True,
    )
    await stream.handle_event({"type": "message_start", "message": result})
    await stream.handle_event({"type": "message_end", "message": result})
    followup = message("assistant", [{"type": "text", "text": "Cannot access it"}], 4)
    await stream.handle_event({"type": "message_start", "message": message("assistant", [], 4)})
    await stream.handle_event(update("text_delta", 0, delta="Cannot access it"))
    await stream.handle_event({"type": "message_end", "message": followup})
    await stream.handle_event({"type": "agent_settled"})
    final = projected(
        entry(user, "u"), entry(assistant, "a"), entry(result, "r"), entry(followup, "a2")
    )
    assert_final_identity(stream, final)
    tool = next(item for item in stream.items() if item.type == "tool")
    assert tool.status == "failed"
    assert tool.content["exitCode"] == 1
    revisions = [item.revision for item in fake_host.timeline_items if item.id == tool.id]
    assert revisions == sorted(set(revisions))
    await stream.close()


@pytest.mark.parametrize("timestamp", [2, None])
async def test_resumed_turn_and_timestamp_collisions_are_stable(fake_host, timestamp) -> None:
    seed = [
        entry(message("user", "old", 1), "old-u"),
        entry(message("assistant", [{"type": "text", "text": "old reply"}], timestamp), "old-a"),
    ]
    stream = PiStreamAccumulator(
        "s",
        "/s.jsonl",
        publish=fake_host.timeline_item_upsert,
        entries=seed,
        throttle_seconds=0,
    )
    user = await user_turn(stream, "new", 10)
    await stream.handle_event(
        {"type": "message_start", "message": message("assistant", [], timestamp)}
    )
    await stream.handle_event(update("text_delta", 0, delta="new reply"))
    assistant = message("assistant", [{"type": "text", "text": "new reply"}], timestamp)
    await stream.handle_event({"type": "message_end", "message": assistant})
    final = projected(*seed, entry(user, "new-u"), entry(assistant, "new-a"))
    assert_final_identity(stream, final)
    live = output(stream.items())
    assert len(live) == 1
    assert live[0].turn_id == "turn-2"
    assert live[0].order_seq == 7
    original_id = next(item.id for item in projected(*seed) if item.role == "assistant")
    assert live[0].id != original_id
    # Reloading the transcript into a fresh projector keeps both messages' ids.
    assert [item.id for item in final] == [
        item.id for item in projected(*seed, entry(user, "new-u"), entry(assistant, "new-a"))
    ]
    await stream.close()


async def test_reset_to_history_branch_cancels_old_flush_and_seeds_correct_ordinal(
    fake_host,
) -> None:
    seed = [
        entry(message("user", "old", 1), "u"),
        entry(message("assistant", [{"type": "text", "text": "reply"}], 2), "a"),
    ]
    stream = PiStreamAccumulator(
        "s",
        "/s.jsonl",
        publish=fake_host.timeline_item_upsert,
        entries=seed,
        throttle_seconds=60,
    )
    await user_turn(stream, "discarded branch", 3)
    await stream.handle_event({"type": "message_start", "message": message("assistant", [], 4)})
    await stream.handle_event(update("text_delta", 0, delta="discarded"))
    await stream.handle_event(update("text_delta", 0, delta=" pending"))
    await stream.reset(entries=seed)
    assert stream.items() == ()
    user = await user_turn(stream, "replacement branch", 5)
    await stream.handle_event({"type": "message_start", "message": message("assistant", [], 6)})
    await stream.handle_event(update("text_delta", 0, delta="replacement"))
    assistant = message("assistant", [{"type": "text", "text": "replacement"}], 6)
    await stream.handle_event({"type": "message_end", "message": assistant})
    assert_final_identity(stream, projected(*seed, entry(user, "u2"), entry(assistant, "a2")))
    assert all(item.content.get("text") != "discarded pending" for item in fake_host.timeline_items)
    await stream.close()


async def test_close_flushes_latest_chunk_and_cancels_timer(fake_host) -> None:
    stream = PiStreamAccumulator(
        "s", "/s.jsonl", publish=fake_host.timeline_item_upsert, throttle_seconds=0.03
    )
    await user_turn(stream)
    await stream.handle_event({"type": "message_start", "message": message("assistant", [])})
    await stream.handle_event(update("text_delta", 0, delta="one"))
    await stream.handle_event(update("text_delta", 0, delta=" two"))
    await stream.close()
    assert fake_host.timeline_items[-1].content["text"] == "one two"
    count = len(fake_host.timeline_items)
    await asyncio.sleep(0.06)
    assert len(fake_host.timeline_items) == count


async def test_missing_start_does_not_guess_message_identity(fake_host) -> None:
    stream = PiStreamAccumulator("s", "/s.jsonl", publish=fake_host.timeline_item_upsert)
    await stream.handle_event(update("text_delta", 0, delta="orphan"))
    assert stream.items() == ()
    assert fake_host.timeline_items == []
    await stream.close()


async def test_adjacent_content_blocks_share_final_identity(fake_host) -> None:
    stream = PiStreamAccumulator(
        "s", "/s.jsonl", publish=fake_host.timeline_item_upsert, throttle_seconds=0
    )
    user = await user_turn(stream)
    await stream.handle_event({"type": "message_start", "message": message("assistant", [])})
    await stream.handle_event(update("thinking_delta", 0, delta="first"))
    await stream.handle_event(update("thinking_delta", 1, delta="second"))
    await stream.handle_event(update("text_delta", 2, delta="hello "))
    await stream.handle_event(update("text_delta", 3, delta="world"))
    assistant = message(
        "assistant",
        [
            {"type": "thinking", "thinking": "first"},
            {"type": "thinking", "thinking": "second"},
            {"type": "text", "text": "hello "},
            {"type": "text", "text": "world"},
        ],
    )
    await stream.handle_event({"type": "message_end", "message": assistant})
    assert len(output(stream.items())) == 2
    assert [item.content["text"] for item in output(stream.items())] == [
        "first\n\nsecond",
        "hello world",
    ]
    assert_final_identity(stream, projected(entry(user, "u"), entry(assistant, "a")))
    await stream.close()


@pytest.mark.parametrize(
    "first,second",
    [
        (
            message("custom", "extension one", customType="note"),
            message("custom", "extension two", customType="note"),
        ),
        (
            message("bashExecution", None, command="ls", output="a", exitCode=0),
            message("bashExecution", None, command="pwd", output="/", exitCode=0),
        ),
        (
            message("branchSummary", None, summary="left branch"),
            message("branchSummary", None, summary="right branch"),
        ),
    ],
)
async def test_streamed_messages_without_entry_ids_keep_distinct_identities(
    fake_host, first: dict, second: dict
) -> None:
    """Pi assigns entry ids after streaming; two such messages must not share an id."""

    stream = PiStreamAccumulator(
        "s", "/s.jsonl", publish=fake_host.timeline_item_upsert, throttle_seconds=0
    )
    await user_turn(stream)
    for value in (first, second):
        await stream.handle_event({"type": "message_start", "message": value})
        await stream.handle_event({"type": "message_end", "message": value})
    await stream.handle_event({"type": "agent_settled"})
    ids = [item.id for item in output(stream.items())]
    assert len(ids) == 2
    assert len(set(ids)) == 2
    by_id: dict[str, list[Any]] = {}
    for item in fake_host.timeline_items:
        by_id.setdefault(item.id, []).append(item.content)
    # Each identity is published once, with its own content only.
    assert all(len(contents) == 1 for contents in by_id.values())
    await stream.close()


async def test_user_message_streams_first_with_its_final_identity(fake_host) -> None:
    """The run's output follows the user message, not the client's optimistic copy."""

    stream = PiStreamAccumulator(
        "s", "/s.jsonl", publish=fake_host.timeline_item_upsert, throttle_seconds=0
    )
    display = {"text": "look", "attachments": [{"fileId": "f1", "name": "a.png"}]}
    # Bound after the stream was seeded, as a send to an idle session does.
    stream.bind_client_message("look\n[note]", "client-1", display)
    user = await user_turn(stream, "look\n[note]", 5)
    await stream.handle_event({"type": "message_start", "message": message("assistant", [], 6)})
    await stream.handle_event(update("text_delta", 0, delta="seen"))
    assistant = message("assistant", [{"type": "text", "text": "seen"}], 6)
    await stream.handle_event({"type": "message_end", "message": assistant})
    first = fake_host.timeline_items[0]
    assert first.role == "user"
    assert first.source["clientMessageId"] == "client-1"
    assert first.content["text"] == "look"
    assert first.content["attachments"] == [{"fileId": "f1", "name": "a.png"}]
    assert first.order_seq < output(fake_host.timeline_items)[0].order_seq
    # Pi's entry id comes later; the settled history keeps the same identity.
    final = projected(
        entry(user, "assigned-later"),
        entry(assistant, "a"),
        client_messages=[("look\n[note]", "client-1")],
        client_displays={"client-1": display},
    )
    assert_final_identity(stream, final)
    await stream.close()
