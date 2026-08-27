from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any

from connector.core.json_kv import JsonKeyValueStore

CLIENT_MESSAGE_BINDINGS_VERSION = 1
MAX_PENDING_PER_SESSION = 128
MAX_MATCHED_PER_SESSION = 1000


@dataclass(frozen=True, slots=True)
class ClaudeHistoryUserMessage:
    native_message_id: str
    text: str


@dataclass(frozen=True, slots=True)
class ClaudeClientMessageBinding:
    session_id: str
    external_session_id: str | None
    client_message_id: str
    platform_item_id: str
    text: str
    attachments: tuple[Mapping[str, object], ...] = ()
    native_message_id: str | None = None


class ClaudePendingClientMessageRegistry:
    """Keep a bounded mapping from recent Web messages to Claude history UUIDs.

    Registration and matching mutate the in-memory registry. When a key-value
    store is configured, those mutations are persisted by external session.
    """

    def __init__(
        self,
        connector_id: str,
        kv_store: JsonKeyValueStore | None = None,
    ) -> None:
        self._connector_id = connector_id
        self._kv_store = kv_store
        self._pending: list[ClaudeClientMessageBinding] = []
        self._matched: list[ClaudeClientMessageBinding] = []
        self._loaded_external_session_ids: set[str] = set()
        self._loaded_unresolved_session_ids: set[str] = set()

    def register_live_message(
        self,
        *,
        session_id: str,
        external_session_id: str | None,
        client_message_id: str | None,
        platform_item_id: str,
        text: str,
        attachments: tuple[Mapping[str, object], ...],
    ) -> None:
        """Record a live platform message until Claude exposes its native UUID."""

        if not client_message_id:
            return
        if external_session_id is not None:
            self.load_external_session(external_session_id)
        else:
            self.load_unresolved_session(session_id)
        self._pending = [
            binding
            for binding in self._pending
            if not (
                binding.session_id == session_id
                and binding.client_message_id == client_message_id
            )
        ]
        self._pending.append(
            ClaudeClientMessageBinding(
                session_id=session_id,
                external_session_id=external_session_id,
                client_message_id=client_message_id,
                platform_item_id=platform_item_id,
                text=text,
                attachments=tuple(dict(attachment) for attachment in attachments),
            )
        )
        self.trim_pending(session_id=session_id)
        if external_session_id is not None:
            self.persist_external_session(external_session_id)
        else:
            self.persist_unresolved_session(session_id)

    def bind_external_session(self, session_id: str, external_session_id: str) -> None:
        """Move all bindings for a platform session to its latest Claude ID."""

        self.load_unresolved_session(session_id)
        self.load_external_session(external_session_id)
        previous_external_session_ids = {
            binding.external_session_id
            for binding in (*self._pending, *self._matched)
            if binding.session_id == session_id
            and binding.external_session_id is not None
            and binding.external_session_id != external_session_id
        }
        self._pending = [
            replace(binding, external_session_id=external_session_id)
            if binding.session_id == session_id
            else binding
            for binding in self._pending
        ]
        self._matched = [
            replace(binding, external_session_id=external_session_id)
            if binding.session_id == session_id
            else binding
            for binding in self._matched
        ]
        self.trim_pending(session_id=session_id)
        self.trim_matched(external_session_id=external_session_id)
        self.delete_unresolved_session(session_id)
        for previous_external_session_id in previous_external_session_ids:
            self.persist_external_session(previous_external_session_id)
        self.persist_external_session(external_session_id)

    def load_unresolved_session(self, session_id: str) -> None:
        if session_id in self._loaded_unresolved_session_ids:
            return
        self._loaded_unresolved_session_ids.add(session_id)
        if self._kv_store is None:
            return
        document = self._kv_store.get(self.unresolved_session_key(session_id))
        if (
            document is None
            or document.get("version") != CLIENT_MESSAGE_BINDINGS_VERSION
        ):
            return
        persisted = bindings_from_value(document.get("pending"))
        existing_client_message_ids = {
            binding.client_message_id
            for binding in self._pending
            if binding.session_id == session_id
        }
        self._pending.extend(
            binding
            for binding in persisted
            if binding.client_message_id not in existing_client_message_ids
        )

    def match_history_messages(
        self,
        *,
        session_id: str,
        external_session_id: str,
        messages: tuple[ClaudeHistoryUserMessage, ...],
        prefer_latest: bool = True,
    ) -> dict[str, ClaudeClientMessageBinding]:
        """Match history UUIDs and persist newly resolved platform bindings."""

        self.load_external_session(external_session_id)
        matches = {
            binding.native_message_id: binding
            for binding in self._matched
            if binding.external_session_id == external_session_id
            and binding.native_message_id is not None
        }
        unresolved_messages = tuple(
            message for message in messages if message.native_message_id not in matches
        )
        pending = [
            binding
            for binding in self._pending
            if binding.external_session_id == external_session_id
            or (
                binding.external_session_id is None and binding.session_id == session_id
            )
        ]
        changed = False
        if prefer_latest:
            indexes_by_text = history_message_indexes_by_text(unresolved_messages)
            upper_message_index = len(unresolved_messages) - 1
            for binding in reversed(pending):
                matched_index = latest_matching_message_index(
                    indexes_by_text,
                    expected_text=binding.text,
                    upper_index=upper_message_index,
                )
                if matched_index is None:
                    continue
                message = unresolved_messages[matched_index]
                matched = self.match_binding(
                    binding=binding,
                    external_session_id=external_session_id,
                    message=message,
                )
                matches[message.native_message_id] = matched
                upper_message_index = matched_index - 1
                changed = True
        else:
            indexes_by_text = history_message_indexes_by_text(unresolved_messages)
            lower_message_index = 0
            for binding in pending:
                matched_index = earliest_matching_message_index(
                    indexes_by_text,
                    expected_text=binding.text,
                    lower_index=lower_message_index,
                )
                if matched_index is None:
                    continue
                message = unresolved_messages[matched_index]
                matched = self.match_binding(
                    binding=binding,
                    external_session_id=external_session_id,
                    message=message,
                )
                matches[message.native_message_id] = matched
                lower_message_index = matched_index + 1
                changed = True
        if changed:
            self.delete_unresolved_session(session_id)
            self.persist_external_session(external_session_id)
        return matches

    def match_binding(
        self,
        *,
        binding: ClaudeClientMessageBinding,
        external_session_id: str,
        message: ClaudeHistoryUserMessage,
    ) -> ClaudeClientMessageBinding:
        matched = replace(
            binding,
            external_session_id=external_session_id,
            native_message_id=message.native_message_id,
        )
        self.record_match(binding, matched)
        return matched

    def bind_live_native_message(
        self,
        *,
        session_id: str,
        external_session_id: str,
        client_message_id: str | None,
        native_message_id: str,
        text: str,
    ) -> bool:
        """Bind one Web message to the UUID replayed by the Claude SDK.

        Side effects:
        - moves the matching pending message into the bounded matched set
        - persists the affected external-session bindings
        """

        if not client_message_id:
            return False
        self.load_external_session(external_session_id)
        for binding in reversed(self._matched):
            if (
                binding.external_session_id == external_session_id
                and binding.client_message_id == client_message_id
                and binding.native_message_id == native_message_id
            ):
                return True
        pending = next(
            (
                binding
                for binding in reversed(self._pending)
                if binding.session_id == session_id
                and binding.client_message_id == client_message_id
                and (
                    binding.external_session_id is None
                    or binding.external_session_id == external_session_id
                )
            ),
            None,
        )
        if pending is None or not client_message_text_matches(text, pending.text):
            return False
        matched = replace(
            pending,
            external_session_id=external_session_id,
            native_message_id=native_message_id,
        )
        self.record_match(pending, matched)
        self.delete_unresolved_session(session_id)
        self.persist_external_session(external_session_id)
        return True

    def record_match(
        self,
        pending: ClaudeClientMessageBinding,
        matched: ClaudeClientMessageBinding,
    ) -> None:
        """Move one pending binding into the bounded matched collection."""

        self._pending = [binding for binding in self._pending if binding != pending]
        self._matched = [
            binding
            for binding in self._matched
            if not (
                binding.external_session_id == matched.external_session_id
                and (
                    binding.native_message_id == matched.native_message_id
                    or binding.client_message_id == matched.client_message_id
                )
            )
        ]
        self._matched.append(matched)
        self.trim_matched(external_session_id=matched.external_session_id)

    def trim_pending(self, *, session_id: str) -> None:
        indexes = [
            index
            for index, binding in enumerate(self._pending)
            if binding.session_id == session_id
        ]
        for index in reversed(indexes[:-MAX_PENDING_PER_SESSION]):
            self._pending.pop(index)

    def trim_matched(self, *, external_session_id: str | None) -> None:
        if external_session_id is None:
            return
        indexes = [
            index
            for index, binding in enumerate(self._matched)
            if binding.external_session_id == external_session_id
        ]
        for index in reversed(indexes[:-MAX_MATCHED_PER_SESSION]):
            self._matched.pop(index)

    def load_external_session(self, external_session_id: str) -> None:
        if external_session_id in self._loaded_external_session_ids:
            return
        self._loaded_external_session_ids.add(external_session_id)
        if self._kv_store is None:
            return
        document = self._kv_store.get(self.external_session_key(external_session_id))
        if (
            document is None
            or document.get("version") != CLIENT_MESSAGE_BINDINGS_VERSION
        ):
            return
        self._pending.extend(bindings_from_value(document.get("pending")))
        self._matched.extend(bindings_from_value(document.get("matched")))

    def persist_external_session(self, external_session_id: str) -> None:
        if self._kv_store is None:
            return
        pending = tuple(
            binding
            for binding in self._pending
            if binding.external_session_id == external_session_id
        )
        matched = tuple(
            binding
            for binding in self._matched
            if binding.external_session_id == external_session_id
        )
        key = self.external_session_key(external_session_id)
        if not pending and not matched:
            self._kv_store.delete(key)
            return
        self._kv_store.set(
            key,
            {
                "version": CLIENT_MESSAGE_BINDINGS_VERSION,
                "pending": [binding_to_mapping(binding) for binding in pending],
                "matched": [binding_to_mapping(binding) for binding in matched],
            },
        )

    def persist_unresolved_session(self, session_id: str) -> None:
        if self._kv_store is None:
            return
        pending = tuple(
            binding
            for binding in self._pending
            if binding.session_id == session_id and binding.external_session_id is None
        )
        self._kv_store.set(
            self.unresolved_session_key(session_id),
            {
                "version": CLIENT_MESSAGE_BINDINGS_VERSION,
                "pending": [binding_to_mapping(binding) for binding in pending],
            },
        )

    def delete_unresolved_session(self, session_id: str) -> None:
        if self._kv_store is not None:
            self._kv_store.delete(self.unresolved_session_key(session_id))

    def external_session_key(self, external_session_id: str) -> str:
        return f"claude/client-messages/{self._connector_id}/{external_session_id}"

    def unresolved_session_key(self, session_id: str) -> str:
        return f"claude/client-messages/{self._connector_id}/pending/{session_id}"


def history_message_indexes_by_text(
    messages: tuple[ClaudeHistoryUserMessage, ...],
) -> dict[str, list[int]]:
    indexes: dict[str, list[int]] = defaultdict(list)
    for index, message in enumerate(messages):
        normalized = normalize_text(message.text)
        indexes[normalized].append(index)
        attachment_base = attachment_echo_base_text(normalized)
        if attachment_base is not None and attachment_base != normalized:
            indexes[attachment_base].append(index)
    return dict(indexes)


def latest_matching_message_index(
    indexes_by_text: Mapping[str, list[int]],
    *,
    expected_text: str,
    upper_index: int,
) -> int | None:
    indexes = indexes_by_text.get(normalize_text(expected_text))
    if not indexes:
        return None
    position = bisect_right(indexes, upper_index)
    return indexes[position - 1] if position > 0 else None


def earliest_matching_message_index(
    indexes_by_text: Mapping[str, list[int]],
    *,
    expected_text: str,
    lower_index: int,
) -> int | None:
    indexes = indexes_by_text.get(normalize_text(expected_text))
    if not indexes:
        return None
    position = bisect_left(indexes, lower_index)
    return indexes[position] if position < len(indexes) else None


def client_message_text_matches(actual: str, expected: str) -> bool:
    actual_text = normalize_text(actual)
    expected_text = normalize_text(expected)
    if actual_text == expected_text:
        return True
    return attachment_echo_base_text(actual_text) == expected_text


def attachment_echo_base_text(value: str) -> str | None:
    marker = "\n\nAttached files:\n"
    marker_index = value.rfind(marker)
    if marker_index < 0:
        return None
    return value[:marker_index]


def normalize_text(value: str) -> str:
    return "\n".join(line.rstrip() for line in value.strip().splitlines())


def binding_to_mapping(binding: ClaudeClientMessageBinding) -> dict[str, Any]:
    return {
        "sessionId": binding.session_id,
        "externalSessionId": binding.external_session_id,
        "clientMessageId": binding.client_message_id,
        "platformItemId": binding.platform_item_id,
        "nativeMessageId": binding.native_message_id,
        "text": binding.text,
        "attachments": [dict(attachment) for attachment in binding.attachments],
    }


def bindings_from_value(value: Any) -> tuple[ClaudeClientMessageBinding, ...]:
    if not isinstance(value, list):
        return ()
    bindings: list[ClaudeClientMessageBinding] = []
    for item in value:
        if not isinstance(item, Mapping):
            continue
        session_id = string_value(item.get("sessionId"))
        client_message_id = string_value(item.get("clientMessageId"))
        platform_item_id = string_value(item.get("platformItemId"))
        text = item.get("text")
        if (
            session_id is None
            or client_message_id is None
            or platform_item_id is None
            or not isinstance(text, str)
        ):
            continue
        bindings.append(
            ClaudeClientMessageBinding(
                session_id=session_id,
                external_session_id=string_value(item.get("externalSessionId")),
                client_message_id=client_message_id,
                platform_item_id=platform_item_id,
                native_message_id=string_value(item.get("nativeMessageId")),
                text=text,
                attachments=attachments_from_value(item.get("attachments")),
            )
        )
    return tuple(bindings)


def attachments_from_value(value: Any) -> tuple[Mapping[str, object], ...]:
    if not isinstance(value, list):
        return ()
    return tuple(dict(item) for item in value if isinstance(item, Mapping))


def string_value(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
