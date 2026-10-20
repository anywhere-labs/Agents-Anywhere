"""Bind platform client message ids to opencode history user messages.

``opencode serve`` never echoes the platform ``clientMessageId`` back in
session history, so a snapshot rebuilt at turn end would otherwise show the
user message as a second item next to the platform's optimistic echo. The web
and desktop clients only merge the optimistic echo when the runtime item
carries the same ``source.clientMessageId``; this registry records live sends
per native session and text-matches them against history messages when the
snapshot is mapped.

Matching is intentionally conservative: bindings are consumed FIFO in send
order, and pending bindings survive across in-turn snapshots (a message enters
opencode history slightly after ``prompt_async`` is accepted). Bindings are
dropped when a turn ends, because a send that never appeared in history will
not appear later.
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any

MAX_PENDING_PER_SESSION = 128


@dataclass(frozen=True, slots=True)
class OpenCodeClientMessageBinding:
    client_message_id: str
    text: str


class OpenCodePendingClientMessageRegistry:
    """In-memory mapping from recent platform messages to history texts."""

    def __init__(self) -> None:
        self._pending: dict[str, deque[OpenCodeClientMessageBinding]] = defaultdict(deque)

    def register(
        self,
        *,
        native_session_id: str,
        client_message_id: str | None,
        text: str,
    ) -> None:
        if not client_message_id or not text:
            return
        queue = self._pending[native_session_id]
        queue.append(OpenCodeClientMessageBinding(client_message_id, normalize_text(text)))
        while len(queue) > MAX_PENDING_PER_SESSION:
            queue.popleft()

    def resolve(
        self,
        native_session_id: str,
        messages: list[dict[str, Any]],
    ) -> dict[str, str]:
        """Return ``{native message id: client message id}`` for matched sends."""

        queue = self._pending.get(native_session_id)
        if not queue:
            return {}
        bindings: deque[tuple[int, str, str]] = deque(
            (index, binding.client_message_id, binding.text)
            for index, binding in enumerate(queue)
        )
        matched: dict[str, str] = {}
        consumed: list[int] = []
        for message in messages:
            info = message.get("info") or {}
            if info.get("role") != "user":
                continue
            message_id = str(info.get("id") or "")
            if not message_id:
                continue
            text = normalize_text(user_message_text(message))
            for position, (binding_index, client_message_id, binding_text) in enumerate(bindings):
                if binding_text == text:
                    matched[message_id] = client_message_id
                    consumed.append(binding_index)
                    del bindings[position]
                    break
        if consumed:
            consumed_set = set(consumed)
            remaining = deque(
                binding
                for index, binding in enumerate(queue)
                if index not in consumed_set
            )
            if remaining:
                self._pending[native_session_id] = remaining
            else:
                del self._pending[native_session_id]
        return matched

    def unresolve(self, native_session_id: str) -> None:
        """Drop unconsumed bindings once the corresponding turn has ended."""

        self._pending.pop(native_session_id, None)


def user_message_text(message: dict[str, Any]) -> str:
    parts = message.get("parts") or []
    # Match the timeline mapper: opencode auto-injects synthetic text parts
    # (e.g. "Called the Read tool with the following input: ...") right after
    # the user's prompt. Without this filter the binding.text ("识别图片")
    # would be concatenated with the synthetic narration and never match the
    # clientMessageId registration, leaving the optimistic echo un-merged.
    return "\n".join(
        str(part.get("text") or "")
        for part in parts
        if part.get("type") == "text" and not part.get("synthetic")
    )


def normalize_text(value: str) -> str:
    return "\n".join(line.rstrip() for line in value.strip().splitlines())
