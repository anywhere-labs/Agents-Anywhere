from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from openai_codex.generated.v2_all import Thread

from connector.runtime_protocol import RuntimeTimelineItem
from connector.runtimes.codex import timeline as codex_timeline
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.timeline.identity import (
    client_message_item_id,
    next_turn_lane_position,
    turn_item_lane,
    turn_position_item_id,
    uses_turn_position_identity,
)


@dataclass(slots=True)
class ActiveTurnPositions:
    next_position_by_lane: dict[str, int] = field(default_factory=dict)
    position_by_item_key: dict[tuple[str, ...], tuple[str, int]] = field(
        default_factory=dict
    )
    projection_by_item_key: dict[
        tuple[str, ...], codex_timeline.CodexTimelineProjection
    ] = field(default_factory=dict)
    platform_item_ids: set[str] = field(default_factory=set)


class CodexTimelineAccumulator:
    def __init__(
        self, pending_messages: PendingClientMessageRegistry | None = None
    ) -> None:
        self._order_by_id: dict[str, int] = {}
        self._projection_by_id: dict[str, codex_timeline.CodexTimelineProjection] = {}
        self._next_order = 0
        self._pending_messages = pending_messages
        self._active_turn_positions: dict[tuple[str, str], ActiveTurnPositions] = {}

    def begin_turn(self, external_session_id: str, turn_id: str) -> None:
        """Start bounded live-item position tracking for one active turn."""
        self._active_turn_positions.setdefault(
            (external_session_id, turn_id), ActiveTurnPositions()
        )

    def end_turn(self, external_session_id: str, turn_id: str | None) -> None:
        """Release all live-item position state owned by a terminal turn."""
        self._release_turn(external_session_id, turn_id)

    def _release_turn(
        self,
        external_session_id: str,
        turn_id: str | None,
    ) -> ActiveTurnPositions | None:
        if turn_id is None:
            return None
        state = self._active_turn_positions.pop((external_session_id, turn_id), None)
        if state is None:
            return None
        for item_id in state.platform_item_ids:
            self._projection_by_id.pop(item_id, None)
            self._order_by_id.pop(item_id, None)
        return state

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
        projection = codex_timeline.timeline_projection_from_sdk_event(
            event
        ) or codex_timeline.timeline_projection_from_event(event)
        if projection is None:
            return None
        projection = self._attach_client_message_id(external_session_id, projection)
        projection = self._assign_live_turn_position(
            external_session_id=external_session_id,
            projection=projection,
        )
        projection = self.stabilize_projection_identity(
            external_session_id=external_session_id,
            projection=projection,
        )
        item_id = projection.item_id(
            external_session_id=external_session_id, fallback_index=0
        )
        state = self._active_turn_state(external_session_id, projection.turn_id)
        item_key = live_projection_item_key(projection)
        previous = (
            state.projection_by_item_key.get(item_key)
            if state is not None and item_key is not None
            else self._projection_by_id.get(item_id)
        )
        merged = projection
        if projection_is_text_delta(projection, event, "agentMessage"):
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
        elif projection_is_text_delta(projection, event, "reasoning"):
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
        if state is not None and item_key is not None:
            state.projection_by_item_key[item_key] = merged
        merged = aggregate_live_reasoning_projection(state, merged)
        self._projection_by_id[item_id] = merged
        return self._runtime_item(
            session_id=session_id,
            external_session_id=external_session_id,
            projection=merged,
            event=event.event_type,
        )

    def items_from_thread_snapshot(
        self,
        session_id: str,
        external_session_id: str,
        thread: dict[str, Any],
        limit: int | None,
    ) -> tuple[RuntimeTimelineItem, ...]:
        projections: list[codex_timeline.CodexTimelineProjection] = []
        positioned_items = positioned_raw_snapshot_items(thread)
        snapshot_items = compact_filtered_positioned_snapshot_items(positioned_items)
        for index, positioned_item in enumerate(
            limit_snapshot_items(snapshot_items, limit)
        ):
            raw_item, turn_position = positioned_item
            raw = dict(raw_item)
            projection = codex_timeline.timeline_projection_from_raw(raw)
            if turn_position is not None:
                projection = projection.with_turn_position(turn_position)
            projections.append(projection)
        return self.items_from_snapshot_projections(
            session_id=session_id,
            external_session_id=external_session_id,
            projections=tuple(projections),
        )

    def items_from_sdk_thread_snapshot(
        self,
        session_id: str,
        external_session_id: str,
        thread: Thread,
        limit: int | None,
    ) -> tuple[RuntimeTimelineItem, ...]:
        projections = codex_timeline.timeline_projections_from_sdk_thread(
            thread=thread,
            limit=limit,
        )
        return self.items_from_snapshot_projections(
            session_id=session_id,
            external_session_id=external_session_id,
            projections=projections,
        )

    def items_from_snapshot_projections(
        self,
        session_id: str,
        external_session_id: str,
        projections: tuple[codex_timeline.CodexTimelineProjection, ...],
    ) -> tuple[RuntimeTimelineItem, ...]:
        prepared: list[tuple[codex_timeline.CodexTimelineProjection, int]] = []
        index_by_id: dict[str, int] = {}
        for index, projection in enumerate(projections):
            projection = self._attach_client_message_id(external_session_id, projection)
            projection = self.stabilize_projection_identity(
                external_session_id=external_session_id,
                projection=projection,
            )
            item_id = projection.item_id(
                external_session_id=external_session_id,
                fallback_index=index,
            )
            existing_index = index_by_id.get(item_id)
            if existing_index is None:
                index_by_id[item_id] = len(prepared)
                prepared.append((projection, index))
                continue
            existing, fallback_index = prepared[existing_index]
            prepared[existing_index] = (
                merge_snapshot_projection(existing, projection),
                fallback_index,
            )
        items: list[RuntimeTimelineItem] = []
        for projection, fallback_index in prepared:
            items.append(
                self._runtime_item(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    projection=projection,
                    event="thread/read",
                    fallback_index=fallback_index,
                    order_seq=len(items),
                )
            )
        return tuple(items)

    def stabilize_projection_identity(
        self,
        external_session_id: str,
        projection: codex_timeline.CodexTimelineProjection,
    ) -> codex_timeline.CodexTimelineProjection:
        if (
            projection.platform_id is None
            and projection.client_message_id_is_bound
            and projection.client_message_id is not None
        ):
            return projection.with_platform_id(
                client_message_item_id(
                    external_session_id=external_session_id,
                    client_message_id=projection.client_message_id,
                )
            )
        if (
            projection.platform_id is None
            and projection.turn_id is not None
            and projection.turn_position is not None
            and uses_turn_position_identity(
                projection.raw_type, projection.effective_role()
            )
        ):
            return projection.with_platform_id(
                turn_position_item_id(
                    external_session_id=external_session_id,
                    turn_id=projection.turn_id,
                    position=projection.turn_position,
                    lane=turn_item_lane(
                        projection.raw_type,
                        projection.effective_role(),
                    ),
                )
            )
        if (
            projection.platform_id is None
            and projection.client_message_id is not None
            and projection.effective_role() == "user"
        ):
            return projection.with_platform_id(
                client_message_item_id(
                    external_session_id=external_session_id,
                    client_message_id=projection.client_message_id,
                )
            )
        return projection

    def _assign_live_turn_position(
        self,
        external_session_id: str,
        projection: codex_timeline.CodexTimelineProjection,
    ) -> codex_timeline.CodexTimelineProjection:
        if projection.turn_id is None:
            return projection
        if not uses_turn_position_identity(
            projection.raw_type, projection.effective_role()
        ):
            return projection
        state = self._active_turn_positions.setdefault(
            (external_session_id, projection.turn_id), ActiveTurnPositions()
        )
        item_key = live_projection_item_key(projection)
        if item_key is not None:
            existing = state.position_by_item_key.get(item_key)
            if existing is not None:
                _, position = existing
                return projection.with_turn_position(position)
        lane = turn_item_lane(projection.raw_type, projection.effective_role())
        position = next_turn_lane_position(state.next_position_by_lane, lane)
        if item_key is not None:
            state.position_by_item_key[item_key] = (lane, position)
        return projection.with_turn_position(position)

    def _active_turn_state(
        self,
        external_session_id: str,
        turn_id: str | None,
    ) -> ActiveTurnPositions | None:
        if turn_id is None:
            return None
        return self._active_turn_positions.get((external_session_id, turn_id))

    def _runtime_item(
        self,
        session_id: str,
        external_session_id: str,
        projection: codex_timeline.CodexTimelineProjection,
        event: str,
        fallback_index: int = 0,
        order_seq: int | None = None,
    ) -> RuntimeTimelineItem:
        item_id = projection.item_id(
            external_session_id=external_session_id,
            fallback_index=fallback_index,
        )
        if order_seq is None:
            order_seq = self._order_by_id.get(item_id)
            if order_seq is None:
                order_seq = self._next_order
                self._next_order += 1
                self._order_by_id[item_id] = order_seq
        if projection.turn_id is not None:
            state = self._active_turn_positions.get(
                (external_session_id, projection.turn_id)
            )
            if state is not None:
                state.platform_item_ids.add(item_id)
        codex_item = codex_timeline.timeline_item_from_projection(
            projection=projection,
            external_session_id=external_session_id,
            fallback_index=fallback_index,
            event=event,
        )
        platform_item = codex_item.to_platform_item(
            session_id=session_id,
            order_seq=order_seq,
        )
        return platform_item

    def _attach_client_message_id(
        self,
        external_session_id: str,
        projection: codex_timeline.CodexTimelineProjection,
    ) -> codex_timeline.CodexTimelineProjection:
        if self._pending_messages is None:
            return projection
        match = self._pending_messages.attach_to_item(
            external_session_id=external_session_id,
            native_item_id=projection.native_id,
            client_message_id=projection.client_message_id,
            raw_type=projection.raw_type,
            role=projection.effective_role(),
            text=projection.pending_message_text(),
            turn_id=projection.turn_id,
        )
        if match is None:
            return projection
        projection = projection.with_pending_message(
            client_message_id=match.client_message_id,
            text=match.text,
            attachments=match.attachments,
        )
        return projection

    def event_delta(self, event: CodexSdkEvent) -> str:
        return codex_timeline.sdk_event_delta_text(
            event
        ) or codex_timeline.notification_delta(event.params)


def projection_is_text_delta(
    projection: codex_timeline.CodexTimelineProjection,
    event: CodexSdkEvent,
    raw_type: str,
) -> bool:
    legacy_delta_events = {
        "agentMessage": {
            "item/agentMessage/delta",
        },
        "reasoning": {
            "item/reasoning/delta",
            "item/reasoning/textDelta",
            "item/reasoning/summaryTextDelta",
        },
    }
    if event.event_type in legacy_delta_events.get(raw_type, set()):
        return True
    if projection.raw_type != raw_type:
        return False
    if projection.status != "inProgress":
        return False
    return bool(codex_timeline.sdk_event_delta_text(event))


def aggregate_live_reasoning_projection(
    state: ActiveTurnPositions | None,
    projection: codex_timeline.CodexTimelineProjection,
) -> codex_timeline.CodexTimelineProjection:
    if state is None or projection.raw_type != "reasoning":
        return projection
    if projection.turn_position is None:
        return projection
    texts = [
        item.pending_message_text()
        for item in state.projection_by_item_key.values()
        if item.raw_type == "reasoning"
        and item.turn_position == projection.turn_position
        and item.pending_message_text()
    ]
    if not texts:
        return projection
    return projection.with_text("\n".join(texts))


def merge_snapshot_projection(
    existing: codex_timeline.CodexTimelineProjection,
    incoming: codex_timeline.CodexTimelineProjection,
) -> codex_timeline.CodexTimelineProjection:
    if existing.raw_type != "reasoning" or incoming.raw_type != "reasoning":
        return incoming
    texts = [
        text
        for text in (
            existing.pending_message_text(),
            incoming.pending_message_text(),
        )
        if text
    ]
    if not texts:
        return incoming
    return incoming.with_text("\n".join(texts))


def live_projection_item_key(
    projection: codex_timeline.CodexTimelineProjection,
) -> tuple[str, ...] | None:
    if projection.explicit_derived_key is not None:
        return ("derived", projection.explicit_derived_key)
    if (
        projection.client_message_id is not None
        and projection.effective_role() == "user"
    ):
        return ("client-message", projection.client_message_id)
    if projection.native_id is not None:
        return ("native", projection.native_id)
    if projection.client_message_id is not None:
        return ("client-message", projection.client_message_id)
    return None


def positioned_raw_snapshot_items(
    thread: Mapping[str, Any],
) -> tuple[tuple[dict[str, Any], int | None], ...]:
    turns = thread.get("turns")
    if isinstance(turns, list):
        positioned: list[tuple[dict[str, Any], int | None]] = []
        for turn in turns:
            if not isinstance(turn, dict):
                continue
            turn_id = codex_sessions.turn_id_from_result(turn)
            next_position_by_lane: dict[str, int] = {}
            for raw_item in codex_timeline.raw_timeline_items(turn):
                raw = dict(raw_item)
                if (
                    turn_id is not None
                    and codex_timeline.timeline_item_turn_id(raw) is None
                ):
                    raw["turnId"] = turn_id
                projection = codex_timeline.timeline_projection_from_raw(raw)
                if turn_id is not None and uses_turn_position_identity(
                    projection.raw_type, projection.effective_role()
                ):
                    lane = turn_item_lane(
                        projection.raw_type,
                        projection.effective_role(),
                    )
                    position = next_turn_lane_position(next_position_by_lane, lane)
                    positioned.append((raw, position))
                else:
                    positioned.append((raw, None))
        return tuple(positioned)

    positions_by_turn_and_lane: dict[tuple[str, str], int] = {}
    positioned = []
    for raw_item in codex_timeline.raw_timeline_items(dict(thread)):
        raw = dict(raw_item)
        turn_id = codex_timeline.timeline_item_turn_id(raw)
        if turn_id is None:
            positioned.append((raw, None))
            continue
        projection = codex_timeline.timeline_projection_from_raw(raw)
        if uses_turn_position_identity(
            projection.raw_type, projection.effective_role()
        ):
            lane = turn_item_lane(
                projection.raw_type,
                projection.effective_role(),
            )
            key = (turn_id, lane)
            if lane == "reasoning":
                assistant_key = (turn_id, "assistant-message")
                position = positions_by_turn_and_lane.get(assistant_key, 0)
            else:
                position = positions_by_turn_and_lane.get(key, 0)
                positions_by_turn_and_lane[key] = position + 1
            positioned.append((raw, position))
        else:
            positioned.append((raw, None))
    return tuple(positioned)


def compact_filtered_positioned_snapshot_items(
    positioned_items: tuple[tuple[dict[str, Any], int | None], ...],
) -> tuple[tuple[dict[str, Any], int | None], ...]:
    has_compaction_marker = any(
        codex_timeline.timeline_raw_type(raw) == "contextCompaction"
        for raw, _ in positioned_items
    )
    if not has_compaction_marker:
        return positioned_items
    return tuple(
        positioned_item
        for positioned_item in positioned_items
        if not is_compacted_transcript_message_mirror(positioned_item[0])
    )


def limit_snapshot_items[T](
    raw_items: tuple[T, ...],
    limit: int | None,
) -> tuple[T, ...]:
    if limit is None:
        return raw_items
    if limit <= 0:
        return ()
    return raw_items[-limit:]


def is_compacted_transcript_message_mirror(raw: Mapping[str, Any]) -> bool:
    return (
        codex_timeline.timeline_raw_type(raw)
        in {"agentMessage", "userMessage", "steeringUserMessage", "message"}
        and codex_timeline.timeline_item_turn_id(raw) is None
    )
