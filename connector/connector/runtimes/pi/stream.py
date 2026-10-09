"""Delta-only Pi RPC reconstruction and throttled timeline publication.

Seed the accumulator with the active branch *before* sending a prompt. Pi
assigns persisted entry ids after streaming, so partial responses go through
the same timestamp/ordinal identity mapper as transcript projection instead.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from copy import deepcopy
from dataclasses import replace
from typing import Any

from connector.runtime_protocol.models import RuntimeTimelineItem
from connector.runtimes.pi.projection import TranscriptProjector

logger = logging.getLogger(__name__)

STREAM_EVENT_TYPES = frozenset(
    {
        "message_start",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
        "agent_settled",
    }
)


class PiStreamAccumulator:
    """One live session's partial messages, tool results and revision ledger.

    ``handle_event`` owns the trailing flush timer; callers need no scheduler.
    ``items`` exposes live items for merging into polling snapshots. Pass final
    transcript items through ``reconcile_snapshot`` so a final sync never
    lowers a streamed item's revision. ``reset`` reseeds a new run/branch and
    keeps revisions; ``close`` flushes and cancels its timer on process exit.
    """

    def __init__(
        self,
        session_id: str,
        external_session_id: str,
        *,
        publish: Callable[[RuntimeTimelineItem], Awaitable[None]],
        entries: Sequence[Mapping[str, Any]] = (),
        client_messages: Sequence[tuple[str, str]] = (),
        throttle_seconds: float = 0.12,
    ) -> None:
        self.session_id = session_id
        self.external_session_id = external_session_id
        self._publish = publish
        self._throttle = max(0.0, throttle_seconds)
        self._timer: asyncio.Task[None] | None = None
        self._flush_lock = asyncio.Lock()
        self._last_flush = float("-inf")
        self._revisions: dict[str, int] = {}
        self._pending: dict[str, RuntimeTimelineItem] = {}
        self._live_items: dict[str, RuntimeTimelineItem] = {}
        self._partial: dict[str, Any] | None = None
        self._blocks: dict[int, dict[str, Any]] = {}
        self._arguments: dict[int, str] = {}
        self._other_start: Mapping[str, Any] | None = None
        self._seed(entries, client_messages)

    def _seed(
        self,
        entries: Sequence[Mapping[str, Any]],
        client_messages: Sequence[tuple[str, str]],
    ) -> None:
        # Messages without entry ids are keyed per run; anchor them to the seed
        # so a later run cannot reuse an earlier run's live identities.
        anchor = next(
            (str(entry["id"]) for entry in reversed(entries) if entry.get("id")),
            str(len(entries)),
        )
        self._projector = TranscriptProjector(
            self.session_id,
            self.external_session_id,
            client_messages=client_messages,
            live_key_anchor=anchor,
        )
        # Leave the last turn open: a subsequent user message closes it in
        # exactly the same location as a complete history projection does.
        for entry in entries:
            self._projector.apply_entry(entry)
        self._known = {item.id: item for item in self._projector.items()}
        for item in self._known.values():
            self._revisions[item.id] = max(self._revisions.get(item.id, 0), item.revision)

    async def reset(
        self,
        *,
        entries: Sequence[Mapping[str, Any]] = (),
        client_messages: Sequence[tuple[str, str]] = (),
    ) -> None:
        """Start a new run from an authoritative branch, discarding old partials."""

        await self._cancel_timer()
        async with self._flush_lock:
            self._partial = None
            self._blocks.clear()
            self._arguments.clear()
            self._other_start = None
            self._pending.clear()
            self._live_items.clear()
            self._last_flush = float("-inf")
            self._seed(entries, client_messages)

    def items(self) -> tuple[RuntimeTimelineItem, ...]:
        """Current live assistant/tool items, including any unflushed changes."""

        return tuple(sorted(self._live_items.values(), key=lambda item: item.order_seq))

    def reconcile_snapshot(
        self, items: Sequence[RuntimeTimelineItem]
    ) -> tuple[RuntimeTimelineItem, ...]:
        """Give authoritative final items revisions at least as new as live ones."""

        result: list[RuntimeTimelineItem] = []
        for item in items:
            current = self._live_items.get(item.id)
            revision = max(self._revisions.get(item.id, 0), item.revision)
            if current is not None and not _same_item(current, item):
                revision += 1
            self._revisions[item.id] = revision
            result.append(replace(item, revision=revision))
        return tuple(result)

    async def handle_event(self, record: Mapping[str, Any]) -> None:
        event_type = record.get("type")
        if event_type not in STREAM_EVENT_TYPES:
            return
        force = False
        if event_type in {"message_start", "message_end"}:
            message = record.get("message")
            if not isinstance(message, Mapping):
                return
            if message.get("role") == "assistant":
                if event_type == "message_start":
                    self._commit_partial()
                    self._partial = deepcopy(dict(message))
                    content = message.get("content")
                    self._blocks = {
                        index: deepcopy(dict(block))
                        for index, block in enumerate(content if isinstance(content, list) else [])
                        if isinstance(block, Mapping)
                    }
                    self._arguments.clear()
                else:
                    self._partial = None
                    self._blocks.clear()
                    self._arguments.clear()
                    self._projector.apply_message(message, entry_id=None)
                    force = True
            elif event_type == "message_start":
                # User and toolResult messages have start/end pairs too. Only
                # apply their authoritative end, never count the user twice.
                self._other_start = deepcopy(dict(message))
            else:
                self._other_start = None
                self._commit_partial()
                self._projector.apply_message(message, entry_id=None)
                force = message.get("role") == "toolResult"
        elif event_type == "message_update":
            update = record.get("assistantMessageEvent")
            if not isinstance(update, Mapping):
                return
            if self._partial is None:
                # Official Pi emits message_start first. Do not guess an id
                # from deltas if a malformed transport has lost that record.
                return
            usage = record.get("usage")
            if isinstance(usage, Mapping):
                self._partial["usage"] = deepcopy(dict(usage))
            self._apply_update(update)
        elif str(event_type).startswith("tool_execution_"):
            self._commit_partial()
            self._projector.apply_tool_execution(record)
            force = event_type == "tool_execution_end"
        elif event_type == "agent_settled":
            self._commit_partial()
            force = True
        self._capture()
        if force or time.monotonic() - self._last_flush >= self._throttle:
            await self.flush()
        elif self._pending and self._timer is None:
            self._timer = asyncio.create_task(self._flush_later())

    def _apply_update(self, update: Mapping[str, Any]) -> None:
        update_type = update.get("type")
        index = update.get("contentIndex")
        if not isinstance(index, int) or isinstance(index, bool) or index < 0:
            return
        if update_type in {"text_start", "text_delta", "text_end"}:
            kind, field = "text", "text"
        elif update_type in {"thinking_start", "thinking_delta", "thinking_end"}:
            kind, field = "thinking", "thinking"
        elif update_type == "toolcall_start":
            self._blocks[index] = {
                "type": "toolCall",
                "id": update.get("id"),
                "name": update.get("toolName"),
                "arguments": {},
            }
            self._arguments[index] = ""
            return
        elif update_type == "toolcall_delta":
            delta = update.get("delta")
            if isinstance(delta, str) and index in self._blocks:
                arguments = self._arguments.get(index, "") + delta
                self._arguments[index] = arguments
                self._blocks[index]["arguments"] = arguments
            return
        elif update_type == "toolcall_end":
            tool_call = update.get("toolCall")
            if isinstance(tool_call, Mapping):
                self._blocks[index] = deepcopy(dict(tool_call))
            return
        else:
            return
        block = self._blocks.setdefault(index, {"type": kind, field: ""})
        if str(update_type).endswith("_delta"):
            delta = update.get("delta")
            if isinstance(delta, str):
                block[field] = str(block.get(field, "")) + delta
        elif str(update_type).endswith("_end"):
            content = update.get("content")
            if isinstance(content, str):
                block[field] = content

    def _partial_message(self) -> dict[str, Any]:
        assert self._partial is not None
        return {
            **self._partial,
            "content": [self._blocks[index] for index in sorted(self._blocks)],
        }

    def _commit_partial(self) -> None:
        if self._other_start is not None:
            # Defensive support for clients which omit non-assistant ends.
            self._projector.apply_message(self._other_start, entry_id=None)
            self._other_start = None
        if self._partial is not None:
            self._projector.apply_message(self._partial_message(), entry_id=None)
            self._partial = None
            self._blocks.clear()
            self._arguments.clear()

    def _capture(self) -> None:
        projector = self._projector
        if self._partial is not None:
            projector = projector.fork()
            projector.apply_message(self._partial_message(), entry_id=None, running=True)
        for item in projector.items():
            if not _streamable(item):
                continue
            previous = self._known.get(item.id)
            if previous is not None and _same_item(previous, item):
                continue
            revision = max(self._revisions.get(item.id, 0) + 1, item.revision)
            item = replace(item, revision=revision)
            self._revisions[item.id] = revision
            self._known[item.id] = item
            self._live_items[item.id] = item
            self._pending[item.id] = item

    async def flush(self) -> None:
        """Publish all pending states immediately (including short final chunks)."""

        async with self._flush_lock:
            pending = sorted(self._pending.values(), key=lambda item: item.order_seq)
            for item in pending:
                # A different item's callback may have yielded while the
                # reader accumulated a newer version of this pending item.
                item = self._pending.pop(item.id, item)
                try:
                    await self._publish(item)
                except asyncio.CancelledError:
                    self._pending.setdefault(item.id, item)
                    raise
                except Exception:
                    # A failed host callback must not kill the RPC reader or
                    # lose the latest partial; the next event/final flush retries.
                    self._pending.setdefault(item.id, item)
                    logger.exception("failed to stream Pi timeline item %s", item.id)
            if pending:
                self._last_flush = time.monotonic()

    async def _flush_later(self) -> None:
        revisions: dict[str, int] = {}
        try:
            delay = max(0.0, self._throttle - (time.monotonic() - self._last_flush))
            await asyncio.sleep(delay)
            revisions = {item.id: item.revision for item in self._pending.values()}
            await self.flush()
        finally:
            self._timer = None
        # Data can arrive while a slow host callback is in flight. Arrange a
        # trailing flush for that data even if the provider pauses afterwards.
        # An unchanged failed callback waits for the next event instead.
        if any(item.revision > revisions.get(item.id, 0) for item in self._pending.values()):
            self._timer = asyncio.create_task(self._flush_later())

    async def _cancel_timer(self) -> None:
        timer = self._timer
        self._timer = None
        if timer is not None:
            timer.cancel()
            try:
                await timer
            except asyncio.CancelledError:
                pass

    async def close(self) -> None:
        """Flush buffered output and release the delayed publication task."""

        await self._cancel_timer()
        await self.flush()


def _streamable(item: RuntimeTimelineItem) -> bool:
    return item.type == "tool" or (item.role == "assistant" and item.type in {"message", "system"})


def _same_item(first: RuntimeTimelineItem, second: RuntimeTimelineItem) -> bool:
    return (
        first.content_hash == second.content_hash
        and first.metadata == second.metadata
        and first.order_seq == second.order_seq
        and first.turn_id == second.turn_id
    )
