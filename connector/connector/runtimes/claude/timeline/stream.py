from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import RuntimeTimelineItem
from connector.runtimes.claude.domain.session import ClaudeSession
from connector.runtimes.claude.timeline.messages import ClaudeMessageProjector


@dataclass(slots=True)
class ClaudeStreamAccumulator:
    partial_message_id: str | None = None
    partial_message_uuid: str | None = None
    partial_text_blocks: dict[int, str] = field(default_factory=dict)
    partial_revision: int = 0

    def item_from_stream_event(
        self,
        *,
        session: ClaudeSession,
        turn_id: str,
        message: Any,
        projector: ClaudeMessageProjector,
    ) -> RuntimeTimelineItem | None:
        event = _stream_event(message)
        if event is None:
            return None
        event_type = _string(event.get("type"))
        if event_type == "message_start":
            self.partial_text_blocks.clear()
            self.partial_revision = 0
            payload = event.get("message")
            self.partial_message_id = (
                _string(payload.get("id")) if isinstance(payload, Mapping) else None
            )
            self.partial_message_uuid = _string(_extract(message, "uuid"))
            return None
        if event_type == "content_block_start":
            index = _int(event.get("index"))
            block = event.get("content_block")
            text = _text_from_stream_block(block)
            if index is not None and text is not None:
                self.partial_text_blocks[index] = text
                return self._partial_item(session, turn_id, message, projector)
            return None
        if event_type == "content_block_delta":
            index = _int(event.get("index"))
            delta = event.get("delta")
            text = _text_from_stream_block(delta)
            if index is not None and text:
                self.partial_text_blocks[index] = (
                    f"{self.partial_text_blocks.get(index, '')}{text}"
                )
                return self._partial_item(session, turn_id, message, projector)
            return None
        if event_type == "message_delta":
            return self._partial_item(session, turn_id, message, projector)
        return None

    def reset(self) -> None:
        self.partial_message_id = None
        self.partial_message_uuid = None
        self.partial_text_blocks.clear()
        self.partial_revision = 0

    def final_item_id(
        self,
        session: ClaudeSession,
        turn_id: str,
    ) -> str | None:
        if self.partial_message_id is None:
            return None
        return _stable_stream_item_id(
            session.session_id,
            session.external_session_id,
            turn_id,
            self.partial_message_id,
        )

    def next_final_revision(self) -> int:
        if self.partial_revision <= 0:
            return 1
        self.partial_revision += 1
        return self.partial_revision

    def _partial_item(
        self,
        session: ClaudeSession,
        turn_id: str,
        message: Any,
        projector: ClaudeMessageProjector,
    ) -> RuntimeTimelineItem | None:
        text = "".join(
            self.partial_text_blocks[index]
            for index in sorted(self.partial_text_blocks)
        )
        if not text:
            return None
        message_id = self.partial_message_id
        if message_id is None:
            logger.warning(
                "dropping Claude stream text without message_start id turn_id={}",
                turn_id,
            )
            return None
        self.partial_revision += 1
        item_id = _stable_stream_item_id(
            session.session_id,
            session.external_session_id,
            turn_id,
            message_id,
        )
        return projector.message_item(
            session=session,
            turn_id=turn_id,
            role="assistant",
            text=text,
            event="claude.turn.assistant.partial",
            status="running",
            native_item_id=self.partial_message_uuid or message_id,
            item_id=item_id,
            revision=self.partial_revision,
        )


def _stream_event(message: Any) -> Mapping[str, Any] | None:
    if not is_stream_event(message):
        return None
    event = _extract(message, "event")
    return event if isinstance(event, Mapping) else None


def is_stream_event(message: Any) -> bool:
    return message.__class__.__name__ == "StreamEvent"


def _text_from_stream_block(value: Any) -> str | None:
    if not isinstance(value, Mapping):
        return None
    block_type = _string(value.get("type"))
    if block_type in {"text", "text_delta"}:
        return _string(value.get("text"))
    if block_type == "input_json_delta":
        return None
    return _string(value.get("text"))


def _stable_stream_item_id(
    session_id: str,
    external_session_id: str | None,
    turn_id: str,
    message_id: str,
) -> str:
    payload = ":".join(
        (
            "claude-stream-message",
            session_id,
            external_session_id or "",
            turn_id,
            message_id,
        )
    )
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]
    return f"msg_claude_{digest}"


def _extract(value: Any, *names: str) -> Any:
    if isinstance(value, Mapping):
        for name in names:
            if name in value:
                return value[name]
        return None
    for name in names:
        candidate = getattr(value, name, None)
        if candidate is not None:
            return candidate
    return None


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None
