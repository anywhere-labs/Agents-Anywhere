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
        if sequence > 0 or isinstance(runtime_state, dict):
            if isinstance(runtime_state, dict):
                runtime_status = runtime_state.get("status")
                if isinstance(runtime_status, str):
                    session = {**session, "status": runtime_status}
            event_payload: dict[str, Any] = {
                "session": session,
                "status": session.get("status"),
            }
            runtime_state = payload.get("runtimeState")
            if isinstance(runtime_state, dict):
                event_payload["state"] = runtime_state
            effective_capabilities = payload.get("effectiveCapabilities")
            if isinstance(effective_capabilities, dict):
                event_payload["effectiveCapabilities"] = effective_capabilities
            events.append(
                protocol_event(
                    session_id,
                    sequence=sequence,
                    event_type="session.status_changed",
                    payload=event_payload,
                )
            )
        effective_capabilities = payload.get("effectiveCapabilities")
        if isinstance(effective_capabilities, dict):
            events.append(
                protocol_event(
                    session_id,
                    sequence=sequence,
                    event_type="runtime.capability.updated",
                    payload={
                        "capabilitySet": effective_capabilities,
                        "effectiveCapabilities": effective_capabilities,
                    },
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
                    event_type="notice.snapshot",
                    payload=snapshot_payload,
                )
            )
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
                status = notice.get("status")
                event_type = (
                    "notice.created"
                    if status == "open" and int(notice.get("revision") or 1) == 1
                    else "notice.updated"
                )
                notice_payload = {"notice": notice}
                events.append(
                    protocol_event(
                        session_id,
                        sequence=sequence,
                        event_type=event_type,
                        payload=notice_payload,
                    )
                )
                events.append(
                    protocol_event(
                        session_id,
                        sequence=sequence,
                        event_type="runtime.notice.updated",
                        payload=notice_payload,
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
