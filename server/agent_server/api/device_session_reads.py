"""What the Server adds to session reads forwarded with ``Client/call`` (D1).

Directory facts (title, status, plan/goal state, display envelopes, catalogs, capabilities) come from the
Server; timeline content comes from the device.

- Device online: the device's body with the Server's parts (``decorate_snapshot``).
- Device offline: 200 with ``deviceOffline: true``, ``historySource: "unavailable"`` and no items
  (``offline_snapshot``).
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
)
from agent_server.core.protocol_v1_2 import (
    ProtocolSessionSnapshotResponseV12,
    SessionViewV12,
)
from agent_server.core.utc import utc_now
from agent_server.services.device_reads import (
    DeviceReadError,
    DeviceReadTimeout,
)


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
