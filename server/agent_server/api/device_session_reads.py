"""Session reads for sessions on v3 devices (read-through, D1).

The session endpoints in ``api/sessions.py`` hand sessions whose device speaks
device-meshcall here. Directory facts (title, status, plan/goal state, display
envelopes, catalogs, capabilities) come from the Server; timeline content comes
from the device.

- Device online: ``historySource: "live"``.
- Device offline: 200 with ``deviceOffline: true``, ``historySource:
  "unavailable"`` and no items; commands answer ``connector_offline`` elsewhere.
- The device took the call and did not finish: 504 ``device_read_timeout``
  (never reported as offline).
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError

from agent_server.core.events import event_cursor
from agent_server.core.models import SessionView
from agent_server.core.protocol import (
    ProtocolCapabilitySet,
    ProtocolTimelineSnapshot,
    SessionRuntimeState,
)
from agent_server.core.protocol_v1_2 import (
    ProtocolEventRecoveryResponseV12,
    ProtocolSessionSnapshotResponseV12,
    ProtocolTimelineResponseV12,
    SessionViewV12,
)
from agent_server.core.utc import utc_now
from agent_server.services.device_reads import (
    DeviceReadError,
    DeviceReadService,
    DeviceReadTimeout,
)

# ``Store/changesSince`` pages the Server follows for one ``/events`` call before
# telling the client to take a snapshot instead.
MAX_CHANGE_PAGES = 8


def device_read_http_error(exc: DeviceReadTimeout | DeviceReadError) -> HTTPException:
    if isinstance(exc, DeviceReadTimeout):
        return HTTPException(status_code=504, detail={"code": exc.code, "message": exc.message})
    return HTTPException(status_code=502, detail={"code": exc.code, "message": exc.message})


def _invalid_device_response(exc: ValidationError) -> HTTPException:
    return HTTPException(
        status_code=502,
        detail={"code": "device_response_invalid", "message": f"the device answered an invalid body: {exc.errors()[:3]}"},
    )


async def session_view_v12(db: Any, session: SessionView) -> SessionViewV12:
    # The session view already carries the 1.2 directory fields (envelopes, plan/goal state).
    return SessionViewV12.model_validate(session.model_dump(mode="json"))


async def device_snapshot(
    *,
    db: Any,
    reads: DeviceReadService,
    session: SessionView,
    limit: int,
    runtime_capabilities: ProtocolCapabilitySet,
    effective_capabilities: ProtocolCapabilitySet,
    catalogs: dict[str, Any],
) -> ProtocolSessionSnapshotResponseV12:
    """Snapshot of a v3 device session; Server-owned parts are passed in."""

    try:
        body = await reads.snapshot(session.connectorId, session.id, limit=limit)
    except (DeviceReadTimeout, DeviceReadError) as exc:
        raise device_read_http_error(exc) from exc
    view = await session_view_v12(db, session)
    if body is None:
        return await offline_snapshot(
            db=db,
            session=session,
            runtime_capabilities=runtime_capabilities,
            effective_capabilities=effective_capabilities,
            catalogs=catalogs,
        )
    timeline = body.get("timeline") or {}
    next_seq = int(timeline.get("nextSeq") or 0)
    try:
        state = body.get("state")
        return ProtocolSessionSnapshotResponseV12(
            goalState=body.get("goalState"),
            session=view,
            state=SessionRuntimeState.model_validate(state) if isinstance(state, dict) else None,
            timeline=ProtocolTimelineSnapshot.model_validate(
                {"items": timeline.get("items") or [], "nextSeq": next_seq, "hasMore": bool(timeline.get("hasMore"))}
            ),
            notices=body.get("notices") or [],
            effectiveCapabilities=effective_capabilities,
            runtimeCapabilities=(
                ProtocolCapabilitySet.model_validate(body["runtimeCapabilities"])
                if isinstance(body.get("runtimeCapabilities"), dict)
                else runtime_capabilities
            ),
            catalogs=catalogs,
            queue=body.get("queue"),
            eventCursor=body.get("eventCursor") or event_cursor(next_seq),
            serverTime=utc_now(),
            historySource="live",
            deviceOffline=False,
        )
    except ValidationError as exc:
        raise _invalid_device_response(exc) from exc


async def offline_snapshot(
    *,
    db: Any,
    session: SessionView,
    runtime_capabilities: ProtocolCapabilitySet,
    effective_capabilities: ProtocolCapabilitySet,
    catalogs: dict[str, Any],
) -> ProtocolSessionSnapshotResponseV12:
    """The snapshot of a session whose device is offline: the Server's directory facts, no content."""

    fields = await db.session_directory_fields(session.id) or {}
    return ProtocolSessionSnapshotResponseV12(
        session=await session_view_v12(db, session),
        state=None,
        timeline=ProtocolTimelineSnapshot(items=[], nextSeq=int(fields.get("headSeq") or 0), hasMore=False),
        notices=[],
        effectiveCapabilities=effective_capabilities,
        runtimeCapabilities=runtime_capabilities,
        catalogs=catalogs,
        queue=None,
        # The client has none of the history; when the device is back it reads from the start.
        eventCursor=event_cursor(0),
        serverTime=utc_now(),
        historySource="unavailable",
        deviceOffline=True,
    )


async def decorate_snapshot(
    body: Any,
    *,
    db: Any,
    session: SessionView,
    runtime_capabilities: ProtocolCapabilitySet,
    effective: Any,
    catalogs: dict[str, Any],
) -> dict[str, Any]:
    """The device's ``Client/call`` snapshot with the Server's parts: its session view, catalogs and effective
    capabilities (derived from the device's live runtime capabilities when the body has them)."""

    out = dict(body) if isinstance(body, dict) else {}
    if isinstance(out.get("runtimeCapabilities"), dict):
        try:
            runtime_capabilities = ProtocolCapabilitySet.model_validate(out["runtimeCapabilities"])
        except ValidationError as exc:
            raise _invalid_device_response(exc) from exc
    out["session"] = (await session_view_v12(db, session)).model_dump(mode="json")
    out["runtimeCapabilities"] = runtime_capabilities.model_dump(mode="json")
    out["effectiveCapabilities"] = effective(runtime_capabilities).model_dump(mode="json")
    out["catalogs"] = catalogs
    out["serverTime"] = utc_now()
    out.setdefault("historySource", "live")
    out.setdefault("deviceOffline", False)
    return out


async def device_timeline(
    *,
    db: Any,
    reads: DeviceReadService,
    session: SessionView,
    mode: str,
    after_seq: int,
    before_order_seq: int | None,
    limit: int,
) -> ProtocolTimelineResponseV12:
    if mode == "history":
        if before_order_seq is None:
            raise HTTPException(status_code=422, detail="beforeOrderSeq is required for history mode")
        read_mode, cursor = "before", before_order_seq
    elif mode == "changes":
        read_mode, cursor = "after", after_seq
    else:
        read_mode, cursor = "latest", None
    try:
        page = await reads.read_page(session.connectorId, session.id, mode=read_mode, cursor=cursor, limit=limit)
    except (DeviceReadTimeout, DeviceReadError) as exc:
        raise device_read_http_error(exc) from exc
    if page is None:
        fields = await db.session_directory_fields(session.id) or {}
        return ProtocolTimelineResponseV12(
            sessionId=session.id,
            items=[],
            nextSeq=int(fields.get("headSeq") or 0),
            hasMore=False,
            serverTime=utc_now(),
            historySource="unavailable",
            deviceOffline=True,
        )
    try:
        return ProtocolTimelineResponseV12(
            sessionId=session.id,
            items=page.items,
            nextSeq=page.headSeq,
            hasMore=page.hasMore,
            serverTime=utc_now(),
        )
    except ValidationError as exc:
        raise _invalid_device_response(exc) from exc


async def device_events(
    *,
    reads: DeviceReadService,
    session: SessionView,
    after_seq: int,
) -> ProtocolEventRecoveryResponseV12:
    events: list[Any] = []
    cursor = after_seq
    try:
        for _page in range(MAX_CHANGE_PAGES):
            changes = await reads.changes_since(session.connectorId, session.id, after_seq=cursor)
            if changes is None:
                return ProtocolEventRecoveryResponseV12(
                    events=[], nextCursor=event_cursor(after_seq), serverTime=utc_now(), deviceOffline=True
                )
            if changes.snapshotRequired:
                return ProtocolEventRecoveryResponseV12(
                    events=[], nextCursor=event_cursor(changes.toSeq), snapshotRequired=True, serverTime=utc_now()
                )
            events.extend(changes.events)
            cursor = max(cursor, changes.toSeq)
            if changes.complete:
                return ProtocolEventRecoveryResponseV12(
                    events=events, nextCursor=event_cursor(cursor), serverTime=utc_now()
                )
    except (DeviceReadTimeout, DeviceReadError) as exc:
        raise device_read_http_error(exc) from exc
    # Too far behind to replay through one request: the client reloads the snapshot.
    return ProtocolEventRecoveryResponseV12(
        events=[], nextCursor=event_cursor(cursor), snapshotRequired=True, serverTime=utc_now()
    )
