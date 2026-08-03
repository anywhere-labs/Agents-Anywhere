from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeTimelineItem
from connector.runtimes.codex import timeline as codex_timeline
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.timeline.identity import (
    client_message_id_from_raw,
    derived_key,
)


class CodexTimelineAccumulator:
    def __init__(
        self, pending_messages: PendingClientMessageRegistry | None = None
    ) -> None:
        self._order_by_id: dict[str, int] = {}
        self._projection_by_id: dict[str, codex_timeline.CodexTimelineProjection] = {}
        self._next_order = 0
        self._pending_messages = pending_messages

    def item_from_notification(
        self,
        session_id: str,
        external_session_id: str,
        method: str,
        params: Mapping[str, Any],
    ) -> RuntimeTimelineItem | None:
        return self.item_from_event(
            session_id=session_id,
            external_session_id=external_session_id,
            event=CodexSdkEvent.from_parts(
                event_type=method,
                params=dict(params),
                raw={"method": method, "params": dict(params)},
                legacy_method_shaped=True,
            ),
        )

    def item_from_event(
        self,
        session_id: str,
        external_session_id: str,
        event: CodexSdkEvent,
    ) -> RuntimeTimelineItem | None:
        projection = codex_timeline.timeline_projection_from_event(event)
        if projection is None:
            return None
        projection = self._attach_client_message_id(
            session_id, external_session_id, projection
        )
        raw = projection.to_legacy_raw()
        item_id = codex_timeline.timeline_item_id(raw, external_session_id, 0)
        previous = self._projection_by_id.get(item_id)
        merged = projection
        if event.event_type == "item/agentMessage/delta":
            previous_text = previous.text if previous and previous.text else ""
            merged = projection.with_status(
                projection.status or "inProgress"
            ).with_text(
                f"{previous_text}{codex_timeline.notification_delta(event.params)}"
            )
        elif event.event_type == "item/commandExecution/outputDelta":
            previous_output = (
                previous.aggregated_output
                if previous and previous.aggregated_output
                else ""
            )
            merged = projection.with_status(
                projection.status or "inProgress"
            ).with_aggregated_output(
                f"{previous_output}{codex_timeline.notification_delta(event.params)}"
            )
        elif event.event_type == "item/reasoning/delta":
            previous_text = previous.text if previous and previous.text else ""
            merged = projection.with_status(
                projection.status or "inProgress"
            ).with_text(
                f"{previous_text}{codex_timeline.notification_delta(event.params)}"
            )
        elif event.event_type == "item/fileChange/patchUpdated":
            previous_patch = previous.patch if previous and previous.patch else ""
            merged = projection.with_status(
                projection.status or "inProgress"
            ).with_patch(
                f"{previous_patch}{codex_timeline.notification_delta(event.params)}"
            )
        elif event.event_type == "item/started":
            merged = projection.with_status(projection.status or "inProgress")
        elif event.event_type == "item/completed":
            merged = projection.with_status(projection.status or "completed")
        self._projection_by_id[item_id] = merged
        return self._runtime_item(
            session_id=session_id,
            external_session_id=external_session_id,
            projection=merged,
            event=event.event_type,
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
            projection = codex_timeline.timeline_projection_from_raw(raw)
            projection = self._attach_client_message_id(
                session_id, external_session_id, projection
            )
            raw = projection.to_legacy_raw()
            item_id = codex_timeline.timeline_item_id(raw, external_session_id, index)
            self._projection_by_id[item_id] = projection
            items.append(
                self._runtime_item(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    projection=projection,
                    event=method,
                    fallback_index=index,
                )
            )
        return tuple(items)

    def _runtime_item(
        self,
        session_id: str,
        external_session_id: str,
        projection: codex_timeline.CodexTimelineProjection,
        event: str,
        fallback_index: int = 0,
    ) -> RuntimeTimelineItem:
        raw_dict = projection.to_legacy_raw()
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
        projection: codex_timeline.CodexTimelineProjection,
    ) -> codex_timeline.CodexTimelineProjection:
        if self._pending_messages is None:
            return projection
        raw = projection.to_legacy_raw()
        client_message_id = self._pending_messages.attach_to_raw_item(
            session_id=session_id,
            external_session_id=external_session_id,
            raw=raw,
        )
        if client_message_id is None:
            return projection
        return projection.with_client_message_id(client_message_id)
