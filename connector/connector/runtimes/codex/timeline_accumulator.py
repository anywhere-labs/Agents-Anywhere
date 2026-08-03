from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeTimelineItem
from connector.runtimes.codex import sessions as codex_sessions
from connector.runtimes.codex import timeline as codex_timeline
from connector.runtimes.codex.pending_messages import PendingClientMessageRegistry
from connector.runtimes.codex.timeline_identity import (
    client_message_id_from_raw,
    derived_key,
)


class CodexTimelineAccumulator:
    def __init__(self, pending_messages: PendingClientMessageRegistry | None = None) -> None:
        self._order_by_id: dict[str, int] = {}
        self._raw_by_id: dict[str, dict[str, Any]] = {}
        self._next_order = 0
        self._pending_messages = pending_messages

    def item_from_notification(
        self,
        session_id: str,
        external_session_id: str,
        method: str,
        params: Mapping[str, Any],
    ) -> RuntimeTimelineItem | None:
        raw = codex_timeline.raw_item_from_notification(method, params)
        if raw is None:
            return None
        self._attach_client_message_id(session_id, external_session_id, raw)
        item_id = codex_timeline.timeline_item_id(raw, external_session_id, 0)
        previous = self._raw_by_id.get(item_id)
        merged = {**copy.deepcopy(previous or {}), **copy.deepcopy(raw)}
        if method == "item/agentMessage/delta":
            merged["type"] = merged.get("type") or "agentMessage"
            merged["status"] = merged.get("status") or "inProgress"
            previous_text = previous.get("text") if previous else ""
            merged["text"] = (
                f"{previous_text if isinstance(previous_text, str) else ''}"
                f"{codex_timeline.notification_delta(params)}"
            )
        elif method == "item/commandExecution/outputDelta":
            merged["type"] = merged.get("type") or "commandExecution"
            merged["status"] = merged.get("status") or "inProgress"
            previous_output = previous.get("aggregatedOutput") if previous else ""
            merged["aggregatedOutput"] = (
                f"{previous_output if isinstance(previous_output, str) else ''}"
                f"{codex_timeline.notification_delta(params)}"
            )
        elif method == "item/started":
            merged.setdefault("status", "inProgress")
        elif method == "item/completed":
            merged["status"] = merged.get("status") or "completed"
        merged["id"] = item_id
        if codex_timeline.timeline_item_turn_id(merged) is None:
            turn_id = codex_sessions.turn_id_from_result(dict(params))
            if turn_id is not None:
                merged["turnId"] = turn_id
        self._raw_by_id[item_id] = merged
        return self._runtime_item(
            session_id=session_id,
            external_session_id=external_session_id,
            raw=merged,
            event=method,
        )

    def items_from_turn_notification(
        self,
        session_id: str,
        external_session_id: str,
        params: Mapping[str, Any],
        method: str,
    ) -> tuple[RuntimeTimelineItem, ...]:
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else params
        if not isinstance(turn, dict):
            return ()
        turn_id = codex_sessions.turn_id_from_result(
            turn
        ) or codex_sessions.turn_id_from_result(dict(params))
        items: list[RuntimeTimelineItem] = []
        for index, raw_item in enumerate(codex_timeline.raw_timeline_items(turn)):
            raw = copy.deepcopy(raw_item)
            if (
                turn_id is not None
                and codex_timeline.timeline_item_turn_id(raw) is None
            ):
                raw["turnId"] = turn_id
            self._attach_client_message_id(session_id, external_session_id, raw)
            item_id = codex_timeline.timeline_item_id(raw, external_session_id, index)
            raw["id"] = item_id
            self._raw_by_id[item_id] = raw
            items.append(
                self._runtime_item(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    raw=raw,
                    event=method,
                    fallback_index=index,
                )
            )
        return tuple(items)

    def _runtime_item(
        self,
        session_id: str,
        external_session_id: str,
        raw: Mapping[str, Any],
        event: str,
        fallback_index: int = 0,
    ) -> RuntimeTimelineItem:
        raw_dict = dict(raw)
        item_id = codex_timeline.timeline_item_id(
            raw_dict, external_session_id, fallback_index
        )
        order_seq = self._order_by_id.get(item_id)
        if order_seq is None:
            order_seq = self._next_order
            self._next_order += 1
            self._order_by_id[item_id] = order_seq
        content = codex_timeline.timeline_item_content(raw_dict)
        item_type = codex_timeline.timeline_item_type(raw_dict)
        status = codex_timeline.timeline_item_status(raw_dict)
        role = codex_timeline.timeline_item_role(raw_dict)
        return RuntimeTimelineItem(
            id=item_id,
            session_id=session_id,
            type=item_type,
            status=status,
            order_seq=order_seq,
            content_hash=codex_timeline.content_hash(
                {
                    "type": item_type,
                    "status": status,
                    "role": role,
                    "content": content,
                }
            ),
            role=role,
            turn_id=codex_timeline.timeline_item_turn_id(raw_dict),
            content=content,
            source={
                "runtime": "codex",
                "event": event,
                "threadId": external_session_id,
                "rawType": raw_dict.get("type"),
                "itemId": raw_dict.get("id") or raw_dict.get("itemId"),
                "derivedKey": derived_key(raw_dict, fallback_index),
                **(
                    {"clientMessageId": client_message_id}
                    if (client_message_id := client_message_id_from_raw(raw_dict))
                    else {}
                ),
            },
            revision=codex_timeline.timeline_item_revision(raw_dict),
            metadata={"raw": raw_dict},
        )

    def _attach_client_message_id(
        self,
        session_id: str,
        external_session_id: str,
        raw: dict[str, Any],
    ) -> None:
        if self._pending_messages is None:
            return
        self._pending_messages.attach_to_raw_item(
            session_id=session_id,
            external_session_id=external_session_id,
            raw=raw,
        )
