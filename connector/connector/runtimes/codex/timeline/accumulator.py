from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any

from openai_codex.generated.v2_all import Thread

from connector.runtime_protocol import RuntimeTimelineItem
from connector.runtimes.codex import timeline as codex_timeline
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.sdk.events import CodexSdkEvent


class CodexTimelineAccumulator:
    def __init__(
        self, pending_messages: PendingClientMessageRegistry | None = None
    ) -> None:
        self._order_by_id: dict[str, int] = {}
        self._projection_by_id: dict[str, codex_timeline.CodexTimelineProjection] = {}
        self._item_id_by_semantic_key: dict[tuple[str, ...], str] = {}
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
        projection = (
            codex_timeline.timeline_projection_from_sdk_event(event)
            or codex_timeline.timeline_projection_from_event(event)
        )
        if projection is None:
            return None
        projection = self._attach_client_message_id(
            session_id, external_session_id, projection
        )
        projection = self.stabilize_projection_identity(
            external_session_id=external_session_id,
            projection=projection,
            fallback_index=0,
            prefer_native_identity=True,
        )
        item_id = projection.item_id(external_session_id=external_session_id, fallback_index=0)
        previous = self._projection_by_id.get(item_id)
        merged = projection
        if event.event_type == "item/agentMessage/delta":
            previous_text = previous.text if previous and previous.text else ""
            merged = projection.with_status(
                projection.status or "inProgress"
            ).with_text(f"{previous_text}{self.event_delta(event)}")
        elif event.event_type == "item/commandExecution/outputDelta":
            previous_output = (
                previous.aggregated_output
                if previous and previous.aggregated_output
                else ""
            )
            merged = projection.with_status(
                projection.status or "inProgress"
            ).with_aggregated_output(f"{previous_output}{self.event_delta(event)}")
        elif event.event_type == "item/reasoning/delta":
            previous_text = previous.text if previous and previous.text else ""
            merged = projection.with_status(
                projection.status or "inProgress"
            ).with_text(f"{previous_text}{self.event_delta(event)}")
        elif event.event_type == "item/fileChange/patchUpdated":
            previous_patch = previous.patch if previous and previous.patch else ""
            merged = projection.with_status(
                projection.status or "inProgress"
            ).with_patch(f"{previous_patch}{self.event_delta(event)}")
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
            raw = dict(raw_item)
            if (
                turn_id is not None
                and codex_timeline.timeline_item_turn_id(raw) is None
            ):
                raw["turnId"] = turn_id
            projection = codex_timeline.timeline_projection_from_raw(raw)
            projection = self._attach_client_message_id(
                session_id, external_session_id, projection
            )
            projection = self.stabilize_projection_identity(
                external_session_id=external_session_id,
                projection=projection,
                fallback_index=index,
                prefer_native_identity=False,
            )
            item_id = projection.item_id(external_session_id=external_session_id, fallback_index=index)
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
        turn_end = self.turn_end_projection_from_notification(params=params, method=method)
        if turn_end is not None:
            turn_end = self.stabilize_projection_identity(
                external_session_id=external_session_id,
                projection=turn_end,
                fallback_index=len(items),
                prefer_native_identity=False,
            )
            items.append(
                self._runtime_item(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    projection=turn_end,
                    event=method,
                    fallback_index=len(items),
                )
            )
        return tuple(items)

    def items_from_turn_event(
        self,
        session_id: str,
        external_session_id: str,
        event: CodexSdkEvent,
    ) -> tuple[RuntimeTimelineItem, ...]:
        projections = codex_timeline.timeline_projections_from_sdk_turn_event(event)
        if projections is None:
            return self.items_from_turn_notification(
                session_id=session_id,
                external_session_id=external_session_id,
                params=event.params,
                method=event.event_type,
            )
        items: list[RuntimeTimelineItem] = []
        for index, projection in enumerate(projections):
            projection = self._attach_client_message_id(
                session_id, external_session_id, projection
            )
            projection = self.stabilize_projection_identity(
                external_session_id=external_session_id,
                projection=projection,
                fallback_index=index,
                prefer_native_identity=False,
            )
            item_id = projection.item_id(external_session_id=external_session_id, fallback_index=index)
            self._projection_by_id[item_id] = projection
            items.append(
                self._runtime_item(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    projection=projection,
                    event=event.event_type,
                    fallback_index=index,
                )
            )
        turn_end = self.turn_end_projection(event)
        if turn_end is not None:
            turn_end = self.stabilize_projection_identity(
                external_session_id=external_session_id,
                projection=turn_end,
                fallback_index=len(items),
                prefer_native_identity=False,
            )
            items.append(
                self._runtime_item(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    projection=turn_end,
                    event=event.event_type,
                    fallback_index=len(items),
                )
            )
        return tuple(items)

    def items_from_thread_snapshot(
        self,
        session_id: str,
        external_session_id: str,
        thread: dict[str, Any],
        limit: int,
    ) -> tuple[RuntimeTimelineItem, ...]:
        items: list[RuntimeTimelineItem] = []
        raw_items = codex_timeline.raw_timeline_items(thread)
        snapshot_items = compact_filtered_thread_snapshot_items(raw_items)
        for index, raw_item in enumerate(snapshot_items[:limit]):
            raw = dict(raw_item)
            if self._pending_messages is not None:
                self._pending_messages.attach_to_raw_item(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    raw=raw,
                )
            projection = codex_timeline.timeline_projection_from_raw(raw)
            projection = self.stabilize_projection_identity(
                external_session_id=external_session_id,
                projection=projection,
                fallback_index=index,
                prefer_native_identity=False,
            )
            item_id = projection.item_id(
                external_session_id=external_session_id,
                fallback_index=index,
            )
            self._projection_by_id[item_id] = projection
            items.append(
                self._runtime_item(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    projection=projection,
                    event="thread/read",
                    fallback_index=index,
                )
            )
        return tuple(items)

    def items_from_sdk_thread_snapshot(
        self,
        session_id: str,
        external_session_id: str,
        thread: Thread,
        limit: int,
    ) -> tuple[RuntimeTimelineItem, ...]:
        items: list[RuntimeTimelineItem] = []
        projections = codex_timeline.timeline_projections_from_sdk_thread(
            thread=thread,
            limit=limit,
        )
        for index, projection in enumerate(projections):
            projection = self._attach_client_message_id(
                session_id, external_session_id, projection
            )
            projection = self.stabilize_projection_identity(
                external_session_id=external_session_id,
                projection=projection,
                fallback_index=index,
                prefer_native_identity=False,
            )
            item_id = projection.item_id(
                external_session_id=external_session_id,
                fallback_index=index,
            )
            self._projection_by_id[item_id] = projection
            items.append(
                self._runtime_item(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    projection=projection,
                    event="thread/read",
                    fallback_index=index,
                )
            )
        return tuple(items)

    def stabilize_projection_identity(
        self,
        external_session_id: str,
        projection: codex_timeline.CodexTimelineProjection,
        fallback_index: int,
        prefer_native_identity: bool,
    ) -> codex_timeline.CodexTimelineProjection:
        semantic_keys = semantic_identity_keys(
            external_session_id=external_session_id,
            projection=projection,
            fallback_index=fallback_index,
        )
        if not semantic_keys:
            return projection
        if (
            prefer_native_identity
            and projection.native_id is not None
            and projection.raw_type != "contextCompaction"
        ):
            item_id = projection.item_id(
                external_session_id=external_session_id,
                fallback_index=fallback_index,
            )
            self.record_semantic_identity(semantic_keys, item_id)
            return projection.with_platform_id(item_id)
        for semantic_key in semantic_keys:
            existing_item_id = self._item_id_by_semantic_key.get(semantic_key)
            if existing_item_id is not None:
                self.record_semantic_identity(semantic_keys, existing_item_id)
                return projection.with_platform_id(existing_item_id)
        item_id = projection.item_id(
            external_session_id=external_session_id,
            fallback_index=fallback_index,
        )
        self.record_semantic_identity(semantic_keys, item_id)
        return projection

    def record_semantic_identity(
        self,
        semantic_keys: tuple[tuple[str, ...], ...],
        item_id: str,
    ) -> None:
        for semantic_key in semantic_keys:
            self._item_id_by_semantic_key[semantic_key] = item_id

    def _runtime_item(
        self,
        session_id: str,
        external_session_id: str,
        projection: codex_timeline.CodexTimelineProjection,
        event: str,
        fallback_index: int = 0,
    ) -> RuntimeTimelineItem:
        item_id = projection.item_id(
            external_session_id=external_session_id,
            fallback_index=fallback_index,
        )
        order_seq = self._order_by_id.get(item_id)
        if order_seq is None:
            order_seq = self._next_order
            self._next_order += 1
            self._order_by_id[item_id] = order_seq
        codex_item = codex_timeline.timeline_item_from_projection(
            projection=projection,
            external_session_id=external_session_id,
            fallback_index=fallback_index,
            event=event,
        )
        return codex_item.to_platform_item(session_id=session_id, order_seq=order_seq)

    def _attach_client_message_id(
        self,
        session_id: str,
        external_session_id: str,
        projection: codex_timeline.CodexTimelineProjection,
    ) -> codex_timeline.CodexTimelineProjection:
        if self._pending_messages is None:
            return projection
        client_message_id = self._pending_messages.attach_to_item(
            session_id=session_id,
            external_session_id=external_session_id,
            native_item_id=projection.native_id,
            raw_type=projection.raw_type,
            role=projection.effective_role(),
            text=projection.pending_message_text(),
            turn_id=projection.turn_id,
        )
        if client_message_id is None:
            return projection
        return projection.with_client_message_id(client_message_id)

    def event_delta(self, event: CodexSdkEvent) -> str:
        return (
            codex_timeline.sdk_event_delta_text(event)
            or codex_timeline.notification_delta(event.params)
        )

    def turn_end_projection(
        self,
        event: CodexSdkEvent,
    ) -> codex_timeline.CodexTimelineProjection | None:
        if not event.is_terminal_turn and not event.is_failed_turn:
            return None
        turn_id = event.turn_id or codex_sessions.turn_id_from_result(event.params)
        return terminal_turn_projection(event_type=event.event_type, turn_id=turn_id)

    def turn_end_projection_from_notification(
        self,
        params: Mapping[str, Any],
        method: str,
    ) -> codex_timeline.CodexTimelineProjection | None:
        if method not in {
            "turn/completed",
            "turn/interrupted",
            "turn/cancelled",
            "turn/failed",
        }:
            return None
        turn_id = codex_sessions.turn_id_from_result(params)
        return terminal_turn_projection(event_type=method, turn_id=turn_id)


def terminal_turn_projection(
    event_type: str,
    turn_id: str | None,
) -> codex_timeline.CodexTimelineProjection | None:
    if turn_id is None:
        return None
    return codex_timeline.CodexTimelineProjection(
        native_id=f"codex_turn_end_{turn_id}",
        raw_type="turnEnd",
        status=terminal_turn_status(event_type),
        role="system",
        turn_id=turn_id,
        message=terminal_turn_message(event_type),
    )


def terminal_turn_status(event_type: str) -> str:
    if event_type == "turn/failed":
        return "failed"
    if event_type == "turn/interrupted":
        return "interrupted"
    if event_type == "turn/cancelled":
        return "cancelled"
    return "completed"


def terminal_turn_message(event_type: str) -> str:
    if event_type == "turn/failed":
        return "Turn failed"
    if event_type == "turn/interrupted":
        return "Turn interrupted"
    if event_type == "turn/cancelled":
        return "Turn cancelled"
    return "Turn completed"


def semantic_identity_keys(
    external_session_id: str,
    projection: codex_timeline.CodexTimelineProjection,
    fallback_index: int,
) -> tuple[tuple[str, ...], ...]:
    if projection.raw_type == "contextCompaction":
        return (("context-compaction", external_session_id),)
    role = projection.effective_role()
    if projection.raw_type not in {"agentMessage", "userMessage", "steeringUserMessage"}:
        return ()
    keys: list[tuple[str, ...]] = []
    if projection.client_message_id is not None and role == "user":
        keys.append(
            (
                "client-message",
                external_session_id,
                projection.client_message_id,
            )
        )
    if projection.native_id is not None:
        keys.append(
            (
                "native-message",
                external_session_id,
                projection.raw_type,
                str(role or ""),
                projection.native_id,
            )
        )
        keys.append(
            (
                "derived-message",
                external_session_id,
                projection.derived_key(fallback_index),
            )
        )
    else:
        keys.append(
            (
                "derived-message",
                external_session_id,
                projection.derived_key(fallback_index),
            )
        )
    text = normalized_timeline_text(projection)
    if text:
        text_digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        keys.append(
            (
                "message-content",
                external_session_id,
                projection.raw_type,
                str(role or ""),
                text_digest,
            )
        )
    return tuple(keys)


def normalized_timeline_text(
    projection: codex_timeline.CodexTimelineProjection,
) -> str:
    text = projection.pending_message_text()
    return "\n".join(line.rstrip() for line in text.strip().splitlines())


def compact_filtered_thread_snapshot_items(
    raw_items: list[dict[str, Any]],
) -> tuple[dict[str, Any], ...]:
    has_compaction_marker = any(
        codex_timeline.timeline_raw_type(raw) == "contextCompaction"
        for raw in raw_items
    )
    if not has_compaction_marker:
        return tuple(raw_items)
    return tuple(
        raw
        for raw in raw_items
        if not is_compacted_transcript_message_mirror(raw)
    )


def is_compacted_transcript_message_mirror(raw: Mapping[str, Any]) -> bool:
    return (
        codex_timeline.timeline_raw_type(raw)
        in {"agentMessage", "userMessage", "steeringUserMessage", "message"}
        and codex_timeline.timeline_item_turn_id(raw) is None
    )
