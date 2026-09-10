from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from connector.core.json_kv import JsonKeyValueStore
from connector.runtime_protocol import RuntimeAttachment
from connector.runtimes.codex import timeline as codex_timeline

CLIENT_MESSAGE_BINDINGS_VERSION = 2
SUPPORTED_CLIENT_MESSAGE_BINDINGS_VERSIONS = {1, CLIENT_MESSAGE_BINDINGS_VERSION}
MAX_BINDINGS_PER_THREAD = 1000


@dataclass(slots=True)
class PendingClientMessage:
    external_session_id: str
    client_message_id: str
    text: str
    attachments: tuple[Mapping[str, object], ...] = ()
    steering: bool = False
    turn_id: str | None = None


@dataclass(frozen=True, slots=True)
class MatchedClientMessage:
    external_session_id: str
    client_message_id: str
    native_item_ids: tuple[str, ...]
    raw_type: str
    role: str | None
    turn_id: str | None
    text: str
    attachments: tuple[Mapping[str, object], ...] = ()


@dataclass(frozen=True, slots=True)
class PendingClientMessageMatch:
    client_message_id: str
    text: str
    attachments: tuple[Mapping[str, object], ...] = ()


class PendingClientMessageRegistry:
    """Track Web-originated messages until Codex history echoes them back."""

    def __init__(
        self,
        connector_id: str,
        kv_store: JsonKeyValueStore | None = None,
    ) -> None:
        self._connector_id = connector_id
        self._kv_store = kv_store
        self._pending: list[PendingClientMessage] = []
        self._matched: list[MatchedClientMessage] = []
        self._loaded_external_session_ids: set[str] = set()

    def register(
        self,
        external_session_id: str,
        client_message_id: str | None,
        text: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        steering: bool = False,
        turn_id: str | None = None,
    ) -> None:
        if client_message_id is None or not client_message_id:
            return
        self._pending = [
            item
            for item in self._pending
            if not (
                item.external_session_id == external_session_id
                and item.client_message_id == client_message_id
            )
        ]
        self._pending.append(
            PendingClientMessage(
                external_session_id=external_session_id,
                client_message_id=client_message_id,
                text=text,
                attachments=tuple(attachment_to_mapping(item) for item in attachments),
                steering=steering,
                turn_id=turn_id,
            )
        )

    def bind_turn(
        self,
        external_session_id: str,
        client_message_id: str | None,
        turn_id: str | None,
    ) -> None:
        if not client_message_id or not turn_id:
            return
        for item in self._pending:
            if (
                item.external_session_id == external_session_id
                and item.client_message_id == client_message_id
            ):
                item.turn_id = turn_id
                return

    def attach_to_raw_item(
        self,
        external_session_id: str,
        raw: dict[str, object],
    ) -> str | None:
        if not _is_user_message(raw):
            return None
        text = codex_timeline.text_from_value(raw) or ""
        turn_id = codex_timeline.timeline_item_turn_id(raw)
        match = self.attach_to_item(
            external_session_id=external_session_id,
            native_item_id=codex_timeline.native_item_id(raw),
            client_message_id=codex_timeline.client_message_id_from_raw(raw),
            raw_type=str(raw.get("type") or ""),
            role=raw.get("role") if isinstance(raw.get("role"), str) else None,
            text=text,
            turn_id=turn_id,
        )
        if match is not None:
            raw["_clientMessageId"] = match.client_message_id
            raw["_pendingText"] = match.text
            raw["_pendingAttachments"] = list(match.attachments)
            return match.client_message_id
        return None

    def attach_to_item(
        self,
        external_session_id: str,
        native_item_id: str | None,
        client_message_id: str | None,
        raw_type: str,
        role: str | None,
        text: str,
        turn_id: str | None,
    ) -> PendingClientMessageMatch | None:
        if not is_user_message(raw_type=raw_type, role=role):
            return None
        self.load_external_session(external_session_id)
        matched = self.matched_client_message(
            external_session_id=external_session_id,
            native_item_id=native_item_id,
            client_message_id=client_message_id,
        )
        if matched is not None:
            self.record_match(
                external_session_id=external_session_id,
                native_item_id=native_item_id,
                client_message_id=matched.client_message_id,
                raw_type=raw_type,
                role=role,
                turn_id=turn_id,
                text=matched.text,
                attachments=matched.attachments,
            )
            return matched
        pending_by_client_id = self.pending_message_by_client_id(
            external_session_id=external_session_id,
            client_message_id=client_message_id,
        )
        if pending_by_client_id is not None:
            self.record_match(
                external_session_id=external_session_id,
                native_item_id=native_item_id,
                client_message_id=pending_by_client_id.client_message_id,
                raw_type=raw_type,
                role=role,
                turn_id=turn_id,
                text=pending_by_client_id.text,
                attachments=pending_by_client_id.attachments,
            )
            return PendingClientMessageMatch(
                client_message_id=pending_by_client_id.client_message_id,
                text=pending_by_client_id.text,
                attachments=pending_by_client_id.attachments,
            )
        if not text:
            return None
        for index in range(len(self._pending) - 1, -1, -1):
            pending = self._pending[index]
            if pending.external_session_id != external_session_id:
                continue
            if pending.turn_id and turn_id and pending.turn_id != turn_id:
                continue
            if pending.steering and raw_type != "steeringUserMessage":
                continue
            if not _text_matches(text, pending.text):
                continue
            self._pending.pop(index)
            self.record_match(
                external_session_id=external_session_id,
                native_item_id=native_item_id,
                client_message_id=pending.client_message_id,
                raw_type=raw_type,
                role=role,
                turn_id=turn_id,
                text=pending.text,
                attachments=pending.attachments,
            )
            return PendingClientMessageMatch(
                client_message_id=pending.client_message_id,
                text=pending.text,
                attachments=pending.attachments,
            )
        return None

    def pending_message_by_client_id(
        self,
        external_session_id: str,
        client_message_id: str | None,
    ) -> PendingClientMessage | None:
        if client_message_id is None:
            return None
        for index in range(len(self._pending) - 1, -1, -1):
            pending = self._pending[index]
            if pending.external_session_id != external_session_id:
                continue
            if pending.client_message_id != client_message_id:
                continue
            return self._pending.pop(index)
        return None

    def matched_client_message(
        self,
        external_session_id: str,
        native_item_id: str | None,
        client_message_id: str | None,
    ) -> PendingClientMessageMatch | None:
        for item in reversed(self._matched):
            if item.external_session_id != external_session_id:
                continue
            if not client_message_matches(
                item=item,
                native_item_id=native_item_id,
                client_message_id=client_message_id,
            ):
                continue
            return PendingClientMessageMatch(
                client_message_id=item.client_message_id,
                text=item.text,
                attachments=item.attachments,
            )
        return None

    def record_match(
        self,
        external_session_id: str,
        native_item_id: str | None,
        client_message_id: str,
        raw_type: str,
        role: str | None,
        turn_id: str | None,
        text: str,
        attachments: tuple[Mapping[str, object], ...] = (),
    ) -> None:
        if not client_message_id:
            return
        self.load_external_session(external_session_id)
        existing = self.match_by_client_message_id(
            external_session_id=external_session_id,
            client_message_id=client_message_id,
        )
        binding = merged_client_message_binding(
            existing=existing,
            external_session_id=external_session_id,
            native_item_ids=(native_item_id,) if native_item_id is not None else (),
            client_message_id=client_message_id,
            raw_type=raw_type,
            role=role,
            turn_id=turn_id,
            text=text,
            attachments=attachments,
        )
        self._matched = [
            item
            for item in self._matched
            if not (
                item.external_session_id == external_session_id
                and item.client_message_id == client_message_id
            )
        ]
        self._matched.append(binding)
        self.persist_external_session(external_session_id)

    def match_by_client_message_id(
        self,
        external_session_id: str,
        client_message_id: str,
    ) -> MatchedClientMessage | None:
        for item in reversed(self._matched):
            if item.external_session_id != external_session_id:
                continue
            if item.client_message_id != client_message_id:
                continue
            return item
        return None

    def load_external_session(self, external_session_id: str) -> None:
        if self._kv_store is None:
            return
        if external_session_id in self._loaded_external_session_ids:
            return
        value = self._kv_store.get(
            client_message_bindings_key(self._connector_id, external_session_id)
        )
        self._loaded_external_session_ids.add(external_session_id)
        if value is None:
            return
        for item in client_message_bindings_from_value(value):
            if item.external_session_id != external_session_id:
                continue
            existing = self.match_by_client_message_id(
                external_session_id=item.external_session_id,
                client_message_id=item.client_message_id,
            )
            self._matched = [
                candidate
                for candidate in self._matched
                if not (
                    candidate.external_session_id == item.external_session_id
                    and candidate.client_message_id == item.client_message_id
                )
            ]
            self._matched.append(
                merged_client_message_binding(
                    existing=existing,
                    external_session_id=item.external_session_id,
                    native_item_ids=item.native_item_ids,
                    client_message_id=item.client_message_id,
                    raw_type=item.raw_type,
                    role=item.role,
                    turn_id=item.turn_id,
                    text=item.text,
                    attachments=item.attachments,
                )
            )

    def persist_external_session(self, external_session_id: str) -> None:
        if self._kv_store is None:
            return
        bindings = [
            item
            for item in self._matched
            if item.external_session_id == external_session_id
        ][-MAX_BINDINGS_PER_THREAD:]
        value = {
            "version": CLIENT_MESSAGE_BINDINGS_VERSION,
            "bindings": [client_message_binding_to_value(item) for item in bindings],
        }
        self._kv_store.set(
            client_message_bindings_key(self._connector_id, external_session_id),
            value,
        )


def client_message_bindings_key(connector_id: str, external_session_id: str) -> str:
    return f"codex/client-message-bindings/{connector_id}/{external_session_id}"


def client_message_matches(
    item: MatchedClientMessage,
    native_item_id: str | None,
    client_message_id: str | None,
) -> bool:
    if client_message_id is not None:
        return item.client_message_id == client_message_id
    return native_item_id is not None and native_item_id in item.native_item_ids


def merged_client_message_binding(
    existing: MatchedClientMessage | None,
    external_session_id: str,
    native_item_ids: tuple[str, ...],
    client_message_id: str,
    raw_type: str,
    role: str | None,
    turn_id: str | None,
    text: str,
    attachments: tuple[Mapping[str, object], ...],
) -> MatchedClientMessage:
    resolved_native_item_ids = add_unique_values(
        existing.native_item_ids if existing is not None else (),
        native_item_ids,
    )
    resolved_text = existing.text if existing is not None and existing.text else text
    resolved_attachments = (
        existing.attachments
        if existing is not None and existing.attachments
        else attachments
    )
    return MatchedClientMessage(
        external_session_id=external_session_id,
        client_message_id=client_message_id,
        native_item_ids=resolved_native_item_ids,
        raw_type=raw_type,
        role=role or (existing.role if existing is not None else None),
        turn_id=turn_id or (existing.turn_id if existing is not None else None),
        text=resolved_text,
        attachments=resolved_attachments,
    )


def add_unique_values(
    values: tuple[str, ...],
    incoming: tuple[str, ...],
) -> tuple[str, ...]:
    result = list(values)
    for value in incoming:
        if value not in result:
            result.append(value)
    return tuple(result)


def client_message_bindings_from_value(
    value: Mapping[str, Any],
) -> tuple[MatchedClientMessage, ...]:
    if value.get("version") not in SUPPORTED_CLIENT_MESSAGE_BINDINGS_VERSIONS:
        return ()
    raw_bindings = value.get("bindings")
    if not isinstance(raw_bindings, list):
        return ()
    bindings: list[MatchedClientMessage] = []
    for raw in raw_bindings:
        if not isinstance(raw, Mapping):
            continue
        binding = client_message_binding_from_value(raw)
        if binding is not None:
            bindings.append(binding)
    return tuple(bindings)


def client_message_binding_from_value(
    value: Mapping[str, Any],
) -> MatchedClientMessage | None:
    external_session_id = string_value(value.get("externalSessionId"))
    client_message_id = string_value(value.get("clientMessageId"))
    if external_session_id is None or client_message_id is None:
        return None
    return MatchedClientMessage(
        external_session_id=external_session_id,
        client_message_id=client_message_id,
        native_item_ids=string_tuple_value(value.get("nativeItemIds")),
        raw_type=string_value(value.get("rawType")) or "userMessage",
        role=string_value(value.get("role")),
        turn_id=string_value(value.get("turnId")),
        text=string_value(value.get("text")) or "",
        attachments=attachments_tuple_value(value.get("attachments")),
    )


def client_message_binding_to_value(item: MatchedClientMessage) -> dict[str, Any]:
    return {
        "externalSessionId": item.external_session_id,
        "clientMessageId": item.client_message_id,
        "nativeItemIds": list(item.native_item_ids),
        "rawType": item.raw_type,
        "role": item.role,
        "turnId": item.turn_id,
        "text": item.text,
        "attachments": [dict(attachment) for attachment in item.attachments],
    }


def string_value(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def string_tuple_value(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str) and item)


def attachments_tuple_value(value: Any) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, list):
        return ()
    attachments: list[Mapping[str, object]] = []
    for item in value:
        if isinstance(item, Mapping):
            attachments.append(dict(item))
    return tuple(attachments)


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
    actual_text = _normalize_text(actual)
    expected_text = _normalize_text(expected)
    if actual_text == expected_text:
        return True
    if not actual_text.startswith(f"{expected_text}\n\n"):
        return False
    suffix = actual_text[len(expected_text) :].strip()
    return attachment_suffix_matches(suffix)


def _normalize_text(value: str) -> str:
    return "\n".join(line.rstrip() for line in value.strip().splitlines())


def attachment_suffix_matches(value: str) -> bool:
    if not value:
        return False
    return value.startswith(("[Attached file: ", "Attached file: "))


def attachment_to_mapping(attachment: RuntimeAttachment) -> Mapping[str, object]:
    result: dict[str, object] = {"fileId": attachment.file_id}
    if attachment.name is not None:
        result["name"] = attachment.name
    if attachment.media_type is not None:
        result["mediaType"] = attachment.media_type
    if attachment.size is not None:
        result["size"] = attachment.size
    if attachment.sha256 is not None:
        result["sha256"] = attachment.sha256
    return result
