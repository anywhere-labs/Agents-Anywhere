from __future__ import annotations

import hashlib
import json
from typing import Any

from agent_server.core.protocol import (
    PROTOCOL_MAX_REVISION,
    ProtocolEventEnvelope,
)
from agent_server.core.utc import utc_now

EVENT_CURSOR_PREFIX = "seq:"


class EventCursorError(ValueError):
    pass


def parse_event_cursor(cursor: str) -> int:
    if not cursor.startswith(EVENT_CURSOR_PREFIX):
        raise EventCursorError("invalid event cursor")
    value = cursor[len(EVENT_CURSOR_PREFIX) :]
    if (
        not value
        or not value.isascii()
        or not value.isdecimal()
        or (len(value) > 1 and value.startswith("0"))
    ):
        raise EventCursorError("invalid event cursor")
    sequence = int(value)
    if sequence > PROTOCOL_MAX_REVISION:
        raise EventCursorError("event cursor exceeds the protocol limit")
    return sequence


def event_cursor(sequence: int) -> str:
    if sequence < 0 or sequence > PROTOCOL_MAX_REVISION:
        raise EventCursorError("event sequence is outside the protocol range")
    return f"{EVENT_CURSOR_PREFIX}{sequence}"


def protocol_event(
    session_id: str,
    *,
    sequence: int,
    event_type: str,
    payload: dict[str, Any],
) -> ProtocolEventEnvelope:
    cursor = event_cursor(sequence)
    event_hash = hashlib.sha256(
        json.dumps([event_type, payload], sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:12]
    return ProtocolEventEnvelope(
        eventId=f"evt_{sequence}_{event_hash}",
        sequence=sequence,
        cursor=cursor,
        type=event_type,
        sessionId=session_id,
        emittedAt=utc_now(),
        payload=payload,
    )


def timeline_events_from_items(
    session_id: str,
    items: list[dict[str, Any]],
) -> list[ProtocolEventEnvelope]:
    events: list[ProtocolEventEnvelope] = []
    for item in items:
        sequence = int(item.get("updatedSeq") or item.get("updated_seq") or 0)
        if sequence <= 0:
            continue
        revision = int(item.get("revision") or 1)
        events.append(
            protocol_event(
                session_id,
                sequence=sequence,
                event_type="timeline.item_updated"
                if revision > 1
                else "timeline.item_created",
                payload={"item": item},
            )
        )
    return events


def events_from_invalidation(payload: dict[str, Any]) -> list[ProtocolEventEnvelope]:
    session_id = payload.get("sessionId")
    if not isinstance(session_id, str):
        return []
    next_sequence = int(payload.get("nextSeq") or 0)
    raw_items = payload.get("items")
    has_items = isinstance(raw_items, list)
    items = raw_items if has_items else []
    if payload.get("timelineReset") and has_items and next_sequence > 0:
        events = [
            protocol_event(
                session_id,
                sequence=next_sequence,
                event_type="timeline.snapshot",
                payload={"items": items},
            )
        ]
    else:
        events = timeline_events_from_items(session_id, items)

    runtime_state = payload.get("runtimeState")
    if isinstance(runtime_state, dict):
        sequence = int(runtime_state.get("updatedSeq") or next_sequence or 0)
        if sequence >= 0:
            events.append(
                protocol_event(
                    session_id,
                    sequence=sequence,
                    event_type="runtime.state.updated",
                    payload={"state": runtime_state},
                )
            )

    message_queue = payload.get("messageQueue")
    if isinstance(message_queue, list):
        sequence = int(payload.get("messageQueueUpdatedSeq") or next_sequence or 0)
        if sequence > 0:
            events.append(
                protocol_event(
                    session_id,
                    sequence=sequence,
                    event_type="session.message_queue.updated",
                    payload={"items": message_queue},
                )
            )

    session = payload.get("session")
    if isinstance(session, dict):
        sequence = int(session.get("updatedSeq") or next_sequence or 0)
        if sequence > 0:
            events.append(
                protocol_event(
                    session_id,
                    sequence=sequence,
                    event_type="session.meta.updated",
                    payload={"session": session},
                )
            )
        capability_set = payload.get("capabilitySet")
        if isinstance(capability_set, dict):
            events.append(
                protocol_event(
                    session_id,
                    sequence=sequence,
                    event_type="runtime.capability.updated",
                    payload={"capabilitySet": capability_set},
                )
            )

    notices = payload.get("notices")
    if isinstance(notices, list):
        if payload.get("noticesReset") and next_sequence > 0:
            snapshot_payload = {"notices": notices}
            events.append(
                protocol_event(
                    session_id,
                    sequence=next_sequence,
                    event_type="runtime.notice.snapshot",
                    payload=snapshot_payload,
                )
            )
        else:
            for notice in notices:
                if not isinstance(notice, dict):
                    continue
                sequence = int(notice.get("updatedSeq") or next_sequence or 0)
                if sequence <= 0:
                    continue
                notice_payload = {"notice": notice_with_event_sequence(notice, sequence)}
                events.append(
                    protocol_event(
                        session_id,
                        sequence=sequence,
                        event_type="runtime.notice.updated",
                        payload=notice_payload,
                    )
                )

    catalogs = payload.get("catalogs")
    if isinstance(catalogs, dict) and next_sequence > 0:
        for catalog_type, catalog in catalogs.items():
            if catalog_type not in {"model", "permission"}:
                continue
            if not isinstance(catalog, dict):
                continue
            events.append(
                protocol_event(
                    session_id,
                    sequence=next_sequence,
                    event_type="runtime.catalog.updated",
                    payload={
                        "catalogType": catalog_type,
                        "catalog": catalog,
                    },
                )
            )

    if payload.get("refetch") and next_sequence > 0:
        events.append(
            protocol_event(
                session_id,
                sequence=next_sequence,
                event_type="session.refetch_required",
                payload={"eventCursor": event_cursor(next_sequence)},
            )
        )
    events.sort(key=lambda event: (event.sequence, event.eventId))
    return events


def notice_with_event_sequence(
    notice: dict[str, Any],
    sequence: int,
) -> dict[str, Any]:
    if isinstance(notice.get("updatedSeq"), int):
        return notice
    return {
        **notice,
        "updatedSeq": sequence,
    }


def revisions_are_complete(
    *,
    after_sequence: int,
    current_sequence: int,
    events: list[ProtocolEventEnvelope],
) -> bool:
    if after_sequence == current_sequence:
        return True
    revisions = {
        event.sequence
        for event in events
        if after_sequence < event.sequence <= current_sequence
    }
    return len(revisions) == current_sequence - after_sequence
