from __future__ import annotations

from dataclasses import dataclass

from connector.runtimes.codex import timeline as codex_timeline


@dataclass(slots=True)
class PendingClientMessage:
    session_id: str
    external_session_id: str
    client_message_id: str
    text: str
    steering: bool = False
    turn_id: str | None = None


class PendingClientMessageRegistry:
    """Track Web-originated messages until Codex history echoes them back."""

    def __init__(self) -> None:
        self._pending: list[PendingClientMessage] = []

    def register(
        self,
        session_id: str,
        external_session_id: str,
        client_message_id: str | None,
        text: str,
        steering: bool = False,
        turn_id: str | None = None,
    ) -> None:
        if client_message_id is None or not client_message_id:
            return
        self._pending = [
            item
            for item in self._pending
            if item.client_message_id != client_message_id
        ]
        self._pending.append(
            PendingClientMessage(
                session_id=session_id,
                external_session_id=external_session_id,
                client_message_id=client_message_id,
                text=text,
                steering=steering,
                turn_id=turn_id,
            )
        )

    def bind_turn(
        self,
        session_id: str,
        client_message_id: str | None,
        turn_id: str | None,
    ) -> None:
        if not client_message_id or not turn_id:
            return
        for item in self._pending:
            if (
                item.session_id == session_id
                and item.client_message_id == client_message_id
            ):
                item.turn_id = turn_id
                return

    def attach_to_raw_item(
        self,
        session_id: str,
        external_session_id: str,
        raw: dict[str, object],
    ) -> str | None:
        if not _is_user_message(raw):
            return None
        text = codex_timeline.text_from_value(raw) or ""
        if not text:
            return None
        turn_id = codex_timeline.timeline_item_turn_id(raw)
        client_message_id = self.attach_to_item(
            session_id=session_id,
            external_session_id=external_session_id,
            raw_type=str(raw.get("type") or ""),
            role=raw.get("role") if isinstance(raw.get("role"), str) else None,
            text=text,
            turn_id=turn_id,
        )
        if client_message_id is not None:
            raw["_clientMessageId"] = client_message_id
        return client_message_id

    def attach_to_item(
        self,
        session_id: str,
        external_session_id: str,
        raw_type: str,
        role: str | None,
        text: str,
        turn_id: str | None,
    ) -> str | None:
        if not is_user_message(raw_type=raw_type, role=role):
            return None
        if not text:
            return None
        for index in range(len(self._pending) - 1, -1, -1):
            pending = self._pending[index]
            if pending.session_id != session_id:
                continue
            if pending.external_session_id != external_session_id:
                continue
            if pending.turn_id and turn_id and pending.turn_id != turn_id:
                continue
            if pending.steering and raw_type != "steeringUserMessage":
                continue
            if not _text_matches(text, pending.text):
                continue
            self._pending.pop(index)
            return pending.client_message_id
        return None


def _is_user_message(raw: dict[str, object]) -> bool:
    role = raw.get("role")
    if role == "user":
        return True
    raw_type = raw.get("type")
    return raw_type in {"userMessage", "steeringUserMessage"}


def is_user_message(raw_type: str, role: str | None) -> bool:
    if role == "user":
        return True
    return raw_type in {"userMessage", "steeringUserMessage"}


def _text_matches(actual: str, expected: str) -> bool:
    return _normalize_text(actual) == _normalize_text(expected)


def _normalize_text(value: str) -> str:
    return "\n".join(line.rstrip() for line in value.strip().splitlines())
