from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import (
    APIRouter,
    Body,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)
from starlette.requests import HTTPConnection

from agent_server.api.connector_runtimes import (
    parse_runtime_model_catalog_response,
    parse_runtime_permission_catalog_response,
)
from agent_server.core.events import (
    EventCursorError,
    event_cursor,
    events_from_invalidation,
    protocol_event,
)
from agent_server.core.models import (
    BulkArchiveResponse,
    InteractionRespondRequest,
    MessageCreateRequest,
    NoticeIn,
    RpcResponsePayload,
    RuntimeNoticeListResponse,
    SessionCommandListResponse,
    SessionCommandRequest,
    SessionCommandResponse,
    SessionCreateAndStartRequest,
    SessionCreateRequest,
    SessionPatchRequest,
    SessionResponse,
    SessionRuntimeState,
    SessionRuntimeStateResponse,
    SessionSelectionPatchRequest,
    SessionSelectionPatchResponse,
    SessionView,
    SteerTurnRequest,
    TakeoverResponse,
)
from agent_server.core.protocol import (
    ProtocolCapabilitiesResponse,
    ProtocolCapabilitySet,
    ProtocolEventRecoveryResponse,
    ProtocolModelCatalogResponse,
    ProtocolPermissionCatalogResponse,
    ProtocolSessionSnapshotResponse,
    ProtocolTimelineResponse,
    ProtocolTimelineSnapshot,
)
from agent_server.core.utc import utc_now
from agent_server.deps import (
    current_user_id,
    get_device_runtime_service,
    get_event_recovery_service,
    get_interaction_service,
    get_rpc,
    get_session_run_service,
    get_session_runtime_state_cache,
    get_store,
    get_timeline_broker,
)
from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.infra.ws_tickets import ClientWsTicketManager
from agent_server.services.connector_presence import (
    with_effective_session_connector_status,
    with_effective_session_connector_statuses,
)
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_runtimes import (
    DeviceRuntimeError,
    DeviceRuntimeService,
)
from agent_server.services.effective_capabilities import (
    derive_session_effective_capabilities,
)
from agent_server.services.event_recovery import EventRecoveryService
from agent_server.services.interactions import (
    InteractionService,
    InteractionServiceError,
)
from agent_server.services.notices import pending_approvals_from_notices
from agent_server.services.session_run import SessionRunError, SessionRunService
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache

router = APIRouter(prefix="/sessions", tags=["sessions"])


def validate_session_id_array(payload: list[str]) -> list[str]:
    if len(payload) < 1:
        raise HTTPException(
            status_code=422,
            detail="ids must contain at least one session id",
        )
    if len(payload) > 200:
        raise HTTPException(
            status_code=422,
            detail="ids must contain at most 200 session ids",
        )

    return payload


def _get_ws_tickets(conn: HTTPConnection) -> ClientWsTicketManager:
    return conn.app.state.ws_tickets


def _raise_session_run_error(exc: SessionRunError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _raise_interaction_error(exc: InteractionServiceError) -> None:
    status_code = {
        "not_found": 404,
        "conflict": 409,
        "invalid": 422,
        "upstream": 502,
    }[exc.kind]
    raise HTTPException(status_code=status_code, detail=exc.detail) from exc


async def _publish_session_protocol_update(
    db: Store,
    broker: TimelineBroker,
    manager: ConnectorRpcManager,
    runtime_state_cache: SessionRuntimeStateCache,
    session_id: str,
    *,
    extra_notices: list[Any] | None = None,
) -> None:
    next_seq = await db.get_session_seq(session_id)
    notices_by_id = {
        notice.noticeId: notice.model_dump(mode="json")
        for notice in await db.list_open_notices(session_id)
    }
    for notice in extra_notices or []:
        notice_id = getattr(notice, "noticeId", None)
        if isinstance(notice_id, str):
            notices_by_id[notice_id] = notice.model_dump(mode="json")
    session = await db.get_session(session_id)
    runtime_state = await read_runtime_state_live(
        db,
        manager,
        runtime_state_cache,
        session,
        None,
    )
    session = session_with_runtime_state(session, runtime_state)
    session = await with_effective_session_connector_status(manager, session)
    runtime_capabilities = await read_session_capabilities_with_fallback(
        db,
        manager,
        session,
        None,
    )
    effective_capabilities = derive_session_effective_capabilities(
        session=session,
        runtime_capabilities=runtime_capabilities,
    )
    envelope: dict[str, Any] = {
        "sessionId": session_id,
        "nextSeq": next_seq,
        "session": session.model_dump(mode="json"),
        "runtimeState": runtime_state.model_dump(mode="json"),
        "capabilitySet": effective_capabilities.model_dump(mode="json"),
        "notices": list(notices_by_id.values()),
    }
    await broker.publish(session_id, envelope)


async def _best_effort_publish_session_protocol_update(
    db: Store,
    broker: TimelineBroker,
    manager: ConnectorRpcManager,
    runtime_state_cache: SessionRuntimeStateCache,
    session_id: str,
    *,
    user_id: str | None,
) -> None:
    try:
        await db.get_session(session_id, user_id=user_id)
        await _publish_session_protocol_update(
            db,
            broker,
            manager,
            runtime_state_cache,
            session_id,
        )
    except Exception:
        return


async def _publish_session_protocol_changes_since(
    db: Store,
    broker: TimelineBroker,
    manager: ConnectorRpcManager,
    runtime_state_cache: SessionRuntimeStateCache,
    session_id: str,
    before_seq: int,
) -> None:
    await _publish_session_protocol_update(
        db,
        broker,
        manager,
        runtime_state_cache,
        session_id,
        extra_notices=await db.list_notices_since(session_id, before_seq),
    )


@router.post("")
async def create_session(
    payload: SessionCreateRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    manager: ConnectorRpcManager = Depends(get_rpc),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> dict[str, Any]:
    try:
        result = await run_service.create_session(payload, user_id=user_id)
    except SessionRunError as exc:
        _raise_session_run_error(exc)
    session = result.get("session")
    if session is not None:
        result = {
            **result,
            "session": await with_effective_session_connector_status(manager, session),
        }
        await publish_dashboard_changed(
            db,
            broker,
            user_id=user_id,
            connector_id=session.connectorId,
            session_id=session.id,
            reason="session.created",
        )
    return result


@router.post("/create-and-start")
async def create_and_start_session(
    payload: SessionCreateAndStartRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    manager: ConnectorRpcManager = Depends(get_rpc),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> dict[str, Any]:
    try:
        result = await run_service.create_and_start_session(payload, user_id=user_id)
    except SessionRunError as exc:
        _raise_session_run_error(exc)
    session = result.get("session")
    if session is not None:
        result = {
            **result,
            "session": await with_effective_session_connector_status(manager, session),
        }
        await publish_dashboard_changed(
            db,
            broker,
            user_id=user_id,
            connector_id=session.connectorId,
            session_id=session.id,
            reason="session.create-and-start",
        )
        await _publish_session_protocol_update(
            db,
            broker,
            manager,
            runtime_state_cache,
            session.id,
        )
    return result


@router.get("")
async def list_sessions(
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> dict[str, Any]:
    sessions = await db.list_sessions(user_id=user_id)
    return {
        "sessions": await with_effective_session_connector_statuses(manager, sessions),
        "serverTime": utc_now(),
    }


@router.get("/{session_id}/meta", response_model=SessionResponse)
async def get_session_meta(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> SessionResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    return SessionResponse(
        session=await with_effective_session_connector_status(manager, session),
        serverTime=utc_now(),
    )


@router.patch("/{session_id}/meta", response_model=SessionResponse)
async def patch_session_meta(
    session_id: str,
    payload: SessionPatchRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> SessionResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None

    if payload.title is not None:
        try:
            session = await db.rename_session(session_id, payload.title, user_id=user_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    if payload.pinned is not None:
        session = await db.set_session_pinned(session_id, payload.pinned, user_id=user_id)
    if payload.archived is not None:
        session = await db.set_session_archived(session_id, payload.archived, user_id=user_id)

    await publish_dashboard_changed(
        db,
        broker,
        user_id=user_id,
        connector_id=session.connectorId,
        session_id=session.id,
        reason="session.updated",
    )
    return SessionResponse(
        session=await with_effective_session_connector_status(manager, session),
        serverTime=utc_now(),
    )


# Removed migration route:
# - old: POST /sessions/bulk-archive with `{ "ids": [...], "archived": true|false }`
# - new: POST /sessions/archive with a direct session id array
# - new: POST /sessions/unarchive with a direct session id array


async def set_sessions_archived(
    session_ids: list[str],
    archived: bool,
    user_id: str,
    db: Store,
    manager: ConnectorRpcManager,
    broker: TimelineBroker,
) -> BulkArchiveResponse:
    """Persist archive metadata and publish dashboard invalidations."""
    sessions, not_found = await db.bulk_set_session_archived(
        session_ids,
        archived,
        user_id=user_id,
    )
    reason = "sessions.archived" if archived else "sessions.unarchived"
    for session in sessions:
        await publish_dashboard_changed(
            db,
            broker,
            user_id=user_id,
            connector_id=session.connectorId,
            session_id=session.id,
            reason=reason,
        )
    return BulkArchiveResponse(
        sessions=await with_effective_session_connector_statuses(manager, sessions),
        notFound=not_found,
        serverTime=utc_now(),
    )


# Removed migration route:
# - old: POST /sessions/bulk-read with `{ "ids": [...] }`
# - new: POST /sessions/read with a direct session id array


@router.post("/archive", response_model=BulkArchiveResponse)
async def archive_sessions(
    payload: list[str] = Body(...),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> BulkArchiveResponse:
    return await set_sessions_archived(
        validate_session_id_array(payload),
        True,
        user_id,
        db,
        manager,
        broker,
    )


@router.post("/unarchive", response_model=BulkArchiveResponse)
async def unarchive_sessions(
    payload: list[str] = Body(...),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> BulkArchiveResponse:
    return await set_sessions_archived(
        validate_session_id_array(payload),
        False,
        user_id,
        db,
        manager,
        broker,
    )


@router.post("/read", response_model=BulkArchiveResponse)
async def mark_sessions_read(
    session_ids: list[str] = Body(..., min_length=1, max_length=200),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> BulkArchiveResponse:
    sessions, not_found = await db.bulk_mark_sessions_read(
        session_ids,
        user_id=user_id,
    )
    for session in sessions:
        await publish_dashboard_changed(
            db,
            broker,
            user_id=user_id,
            connector_id=session.connectorId,
            session_id=session.id,
            reason="sessions.read",
        )
    return BulkArchiveResponse(
        sessions=await with_effective_session_connector_statuses(manager, sessions),
        notFound=not_found,
        serverTime=utc_now(),
    )


# Removed migration route:
# - old: POST /sessions/{session_id}/read
# - new: POST /sessions/read with a direct session id array


@router.get("/{session_id}/runtime/state", response_model=SessionRuntimeStateResponse)
async def session_runtime_state(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> SessionRuntimeStateResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
        state = await read_runtime_state_live(
            db,
            manager,
            runtime_state_cache,
            session,
            user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    return SessionRuntimeStateResponse(state=state, serverTime=utc_now())


@router.get("/{session_id}/runtime/capabilities", response_model=ProtocolCapabilitiesResponse)
async def session_runtime_capabilities(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> ProtocolCapabilitiesResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    session = await with_effective_session_connector_status(manager, session)
    runtime_capabilities = await read_session_capabilities_from_connector(
        manager,
        session,
    )
    capability_set = derive_session_effective_capabilities(
        session=session,
        runtime_capabilities=runtime_capabilities,
    )
    return ProtocolCapabilitiesResponse(
        connectorId=session.connectorId,
        capabilitySet=capability_set,
        serverTime=utc_now(),
    )


@router.get(
    "/{session_id}/runtime/catalogs/model",
    response_model=ProtocolModelCatalogResponse,
)
async def session_runtime_model_catalog(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    device_runtimes: DeviceRuntimeService = Depends(get_device_runtime_service),
) -> ProtocolModelCatalogResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
        await device_runtimes.ensure_active_running(
            session.connectorId,
            session.runtime,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    except DeviceRuntimeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    result = await request_session_runtime_catalog(
        manager,
        session,
        method="runtime.modelCatalog",
        limit=200,
    )
    return ProtocolModelCatalogResponse(
        catalog=parse_runtime_model_catalog_response(result),
        serverTime=utc_now(),
    )


@router.get(
    "/{session_id}/runtime/catalogs/permission",
    response_model=ProtocolPermissionCatalogResponse,
)
async def session_runtime_permission_catalog(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    device_runtimes: DeviceRuntimeService = Depends(get_device_runtime_service),
) -> ProtocolPermissionCatalogResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
        await device_runtimes.ensure_active_running(
            session.connectorId,
            session.runtime,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    except DeviceRuntimeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    result = await request_session_runtime_catalog(
        manager,
        session,
        method="runtime.permissionCatalog",
        limit=200,
    )
    return ProtocolPermissionCatalogResponse(
        catalog=parse_runtime_permission_catalog_response(result),
        serverTime=utc_now(),
    )


@router.patch("/{session_id}/runtime/selections", response_model=SessionSelectionPatchResponse)
async def patch_session_selections(
    session_id: str,
    payload: SessionSelectionPatchRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> SessionSelectionPatchResponse:
    try:
        state, connector_result = await run_service.update_session_selections(
            session_id,
            payload,
            user_id=user_id,
        )
    except SessionRunError as exc:
        _raise_session_run_error(exc)
    await _best_effort_publish_session_protocol_update(
        db,
        broker,
        manager,
        runtime_state_cache,
        session_id,
        user_id=user_id,
    )
    return SessionSelectionPatchResponse(
        ok=True,
        state=state,
        connectorResult=connector_result,
        serverTime=utc_now(),
    )


@router.get("/{session_id}/timeline", response_model=ProtocolTimelineResponse)
async def session_timeline(
    session_id: str,
    after_seq: int = Query(0, alias="afterSeq", ge=0),
    before_order_seq: int | None = Query(None, alias="beforeOrderSeq", ge=1),
    mode: str = Query("latest", pattern="^(latest|changes|history)$"),
    limit: int = Query(200, ge=1, le=500),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> ProtocolTimelineResponse:
    try:
        await db.get_session(session_id, user_id=user_id)
        if mode == "latest":
            items, has_more = await db.list_timeline_latest(
                session_id=session_id,
                limit=limit,
            )
        elif mode == "history":
            if before_order_seq is None:
                raise HTTPException(
                    status_code=422,
                    detail="beforeOrderSeq is required for history mode",
                )
            items, has_more = await db.list_timeline_before_order_seq(
                session_id=session_id,
                before_order_seq=before_order_seq,
                limit=limit,
            )
        else:
            items, has_more = await db.list_timeline_since(
                session_id=session_id,
                after_seq=after_seq,
                limit=limit,
            )
        next_seq = await db.get_session_seq(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    return ProtocolTimelineResponse(
        sessionId=session_id,
        items=items,
        nextSeq=next_seq,
        hasMore=has_more,
        serverTime=utc_now(),
    )


# Removed migration route:
# - old: GET /sessions/{session_id}/state
# - new: GET /sessions/{session_id}/snapshot for initial aggregate hydration
# - new: GET /sessions/{session_id}/timeline for durable timeline reads
# - new: GET /sessions/{session_id}/runtime/state for live runtime state


@router.get("/{session_id}/snapshot", response_model=ProtocolSessionSnapshotResponse)
async def session_snapshot(
    session_id: str,
    limit: int = Query(200, ge=1, le=500),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> ProtocolSessionSnapshotResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
        items, has_more = await db.list_timeline_latest(session_id=session_id, limit=limit)
        notices = await db.list_open_notices(session_id)
        approvals = pending_approvals_from_notices(notices)
        runtime_state = await read_runtime_state_live(
            db,
            manager,
            runtime_state_cache,
            session,
            user_id,
        )
        session = session_with_runtime_state(session, runtime_state)
        session = await with_effective_session_connector_status(manager, session)
        runtime_capabilities = await read_session_capabilities_with_fallback(
            db,
            manager,
            session,
            user_id,
        )
        effective_capabilities = derive_session_effective_capabilities(
            session=session,
            runtime_capabilities=runtime_capabilities,
        )
        next_seq = await db.get_session_seq(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    return ProtocolSessionSnapshotResponse(
        session=session,
        state=runtime_state,
        timeline=ProtocolTimelineSnapshot(items=items, nextSeq=next_seq, hasMore=has_more),
        approvals=approvals,
        notices=notices,
        effectiveCapabilities=effective_capabilities,
        runtimeCapabilities=runtime_capabilities,
        catalogs={},
        eventCursor=event_cursor(next_seq),
        serverTime=utc_now(),
    )


# Removed migration route:
# - old: GET /sessions/events/dashboard
# - new: WS /dashboard/ws


@router.get("/{session_id}/events")
async def session_events(
    session_id: str,
    after: str = Query("seq:0"),
    user_id: str = Depends(current_user_id),
    recovery: EventRecoveryService = Depends(get_event_recovery_service),
) -> ProtocolEventRecoveryResponse:
    try:
        return await recovery.recover(
            session_id,
            after=after,
            user_id=user_id,
        )
    except EventCursorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None


@router.websocket("/{session_id}/ws")
async def session_ws(
    websocket: WebSocket,
    session_id: str,
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    tickets: ClientWsTicketManager = Depends(_get_ws_tickets),
) -> None:
    ticket_value = websocket.query_params.get("ticket")
    if not isinstance(ticket_value, str) or not ticket_value:
        await websocket.close(code=1008, reason="missing ticket")
        return
    ticket = await tickets.consume(ticket_value, session_id=session_id)
    if ticket is None:
        await websocket.close(code=1008, reason="invalid ticket")
        return
    try:
        await db.get_session(session_id, user_id=ticket.user_id)
    except KeyError:
        await websocket.close(code=1008, reason="session not found")
        return

    await websocket.accept()
    queue = await broker.register(session_id)
    try:
        next_seq = await db.get_session_seq(session_id)
        await websocket.send_json(
            protocol_event(
                session_id,
                sequence=next_seq,
                event_type="session.subscribed",
                payload={
                    "clientId": ticket.client_id,
                    "eventCursor": event_cursor(next_seq),
                },
            ).model_dump(mode="json")
        )
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), timeout=15.0)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "keepalive", "serverTime": utc_now()})
                continue
            try:
                invalidation = json.loads(message)
            except json.JSONDecodeError:
                continue
            if not isinstance(invalidation, dict):
                continue
            for event in events_from_invalidation(invalidation):
                await websocket.send_json(event.model_dump(mode="json"))
    except WebSocketDisconnect:
        pass
    finally:
        await broker.unregister(session_id, queue)


@router.post("/{session_id}/takeover", response_model=TakeoverResponse)
async def enable_takeover(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> TakeoverResponse:
    try:
        await db.get_session(session_id, user_id=user_id)
        session = await db.set_takeover(session_id, True)
        await _publish_session_protocol_update(
            db,
            broker,
            manager,
            runtime_state_cache,
            session_id,
        )
        return TakeoverResponse(
            session=await with_effective_session_connector_status(manager, session)
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None


@router.delete("/{session_id}/takeover", response_model=TakeoverResponse)
async def disable_takeover(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> TakeoverResponse:
    try:
        await db.get_session(session_id, user_id=user_id)
        session = await db.set_takeover(session_id, False)
        await _publish_session_protocol_update(
            db,
            broker,
            manager,
            runtime_state_cache,
            session_id,
        )
        return TakeoverResponse(
            session=await with_effective_session_connector_status(manager, session)
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None


# Removed migration route:
# - old: GET /sessions/{session_id}/commands with optional query matching
# - new: GET /sessions/{session_id}/runtime/commands
# Frontend performs fuzzy matching locally after reading the full runtime list.


@router.get("/{session_id}/runtime/commands", response_model=SessionCommandListResponse)
async def list_session_runtime_commands(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> SessionCommandListResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    params: dict[str, Any] = {
        "sessionId": session.id,
        "runtime": session.runtime,
        "limit": 100,
    }
    if session.externalSessionId:
        params["externalSessionId"] = session.externalSessionId
    try:
        result = await manager.request(
            session.connectorId,
            "session.commands",
            params,
            timeout=30,
        )
    except ConnectorOfflineError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ConnectorRpcError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": exc.code, "message": exc.message or exc.code},
        ) from exc
    commands = result.get("commands") if isinstance(result, dict) else None
    if not isinstance(commands, list):
        raise HTTPException(
            status_code=502,
            detail={
                "code": "invalid_command_catalog",
                "message": "connector did not return a command list",
            },
        )
    return SessionCommandListResponse(commands=commands, serverTime=utc_now())


@router.post("/{session_id}/runtime/commands", response_model=SessionCommandResponse)
async def execute_session_command(
    session_id: str,
    payload: SessionCommandRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> SessionCommandResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    params: dict[str, Any] = {
        "sessionId": session.id,
        "runtime": session.runtime,
        "command": payload.command,
        "args": payload.args,
    }
    if session.externalSessionId:
        params["externalSessionId"] = session.externalSessionId
    if payload.raw:
        params["raw"] = payload.raw
    try:
        result = await manager.request(
            session.connectorId,
            "session.command.execute",
            params,
            timeout=30,
        )
    except ConnectorOfflineError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ConnectorRpcError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": exc.code, "message": exc.message or exc.code},
        ) from exc
    if not isinstance(result, dict):
        raise HTTPException(
            status_code=502,
            detail={
                "code": "invalid_command_result",
                "message": "connector did not return a command result",
            },
        )
    return SessionCommandResponse(
        command=str(result.get("command") or payload.command),
        ok=bool(result.get("ok", True)),
        code=result.get("code") if isinstance(result.get("code"), str) else None,
        message=result.get("message") if isinstance(result.get("message"), str) else None,
        result=result.get("result"),
        serverTime=utc_now(),
    )


@router.post("/{session_id}/runtime/messages", response_model=RpcResponsePayload)
async def send_message(
    session_id: str,
    payload: MessageCreateRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    manager: ConnectorRpcManager = Depends(get_rpc),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> RpcResponsePayload:
    try:
        result = await run_service.send_message(session_id, payload, user_id=user_id)
        await _publish_session_protocol_update(
            db,
            broker,
            manager,
            runtime_state_cache,
            session_id,
        )
        return result
    except SessionRunError as exc:
        await _best_effort_publish_session_protocol_update(
            db,
            broker,
            manager,
            runtime_state_cache,
            session_id,
            user_id=user_id,
        )
        _raise_session_run_error(exc)


@router.post("/{session_id}/runtime/interrupt", response_model=RpcResponsePayload)
async def interrupt_session(
    session_id: str,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    manager: ConnectorRpcManager = Depends(get_rpc),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> RpcResponsePayload:
    try:
        before_seq = await db.get_session_seq(session_id)
        result = await run_service.interrupt_session(session_id, user_id=user_id)
        await _publish_session_protocol_changes_since(
            db,
            broker,
            manager,
            runtime_state_cache,
            session_id,
            before_seq,
        )
        return result
    except SessionRunError as exc:
        await _best_effort_publish_session_protocol_update(
            db,
            broker,
            manager,
            runtime_state_cache,
            session_id,
            user_id=user_id,
        )
        _raise_session_run_error(exc)


@router.post("/{session_id}/runtime/steer", response_model=RpcResponsePayload)
async def steer_session(
    session_id: str,
    payload: SteerTurnRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    manager: ConnectorRpcManager = Depends(get_rpc),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> RpcResponsePayload:
    try:
        result = await run_service.steer_session(
            session_id,
            payload,
            user_id=user_id,
        )
        await _publish_session_protocol_update(
            db,
            broker,
            manager,
            runtime_state_cache,
            session_id,
        )
        return result
    except SessionRunError as exc:
        await _best_effort_publish_session_protocol_update(
            db,
            broker,
            manager,
            runtime_state_cache,
            session_id,
            user_id=user_id,
        )
        _raise_session_run_error(exc)


@router.get("/{session_id}/runtime/notices", response_model=RuntimeNoticeListResponse)
async def list_session_runtime_notices(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RuntimeNoticeListResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    notices = await read_session_notices_from_connector(manager, session)
    return RuntimeNoticeListResponse(
        notices=notices,
        serverTime=utc_now(),
    )


@router.post("/{session_id}/runtime/notices/{notice_id}/respond", response_model=RpcResponsePayload)
async def respond_interaction(
    session_id: str,
    notice_id: str,
    payload: InteractionRespondRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    manager: ConnectorRpcManager = Depends(get_rpc),
    interaction_service: InteractionService = Depends(get_interaction_service),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> RpcResponsePayload:
    try:
        before_seq = await db.get_session_seq(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="interaction not found") from None
    try:
        result = await interaction_service.respond(
            session_id,
            notice_id,
            action_id=payload.actionId,
            input_data=payload.input,
            user_id=user_id,
        )
    except InteractionServiceError as exc:
        if exc.changed:
            await _publish_session_protocol_changes_since(
                db,
                broker,
                manager,
                runtime_state_cache,
                session_id,
                before_seq,
            )
        _raise_interaction_error(exc)
    await _publish_session_protocol_changes_since(
        db,
        broker,
        manager,
        runtime_state_cache,
        session_id,
        before_seq,
    )
    return result


@router.post("/{session_id}/sync", response_model=RpcResponsePayload)
async def sync_session(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    device_runtimes: DeviceRuntimeService = Depends(get_device_runtime_service),
) -> RpcResponsePayload:
    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    if not await manager.is_online(session.connectorId):
        raise HTTPException(status_code=409, detail="connector is offline")
    if not session.externalSessionId:
        raise HTTPException(status_code=409, detail="session has no external runtime id")
    try:
        await device_runtimes.ensure_active_running(
            session.connectorId,
            session.runtime,
            user_id=user_id,
        )
    except DeviceRuntimeError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    try:
        result = await manager.request(
            session.connectorId,
            "session.sync",
            {
                "sessionId": session.id,
                "runtime": session.runtime,
                "externalSessionId": session.externalSessionId,
            },
            timeout=60,
        )
    except ConnectorOfflineError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ConnectorRpcError as exc:
        raise HTTPException(status_code=502, detail=exc.message or exc.code) from exc
    return RpcResponsePayload(ok=True, result=result)


async def read_runtime_state_live(
    db: Store,
    manager: ConnectorRpcManager,
    runtime_state_cache: SessionRuntimeStateCache,
    session: SessionView,
    user_id: str | None,
) -> SessionRuntimeState:
    """Read the latest runtime-owned session state.

    Side effects:
    - may perform connector RPC to the owning runtime;
    - does not rely on DB status as the source of runtime truth.
    """

    if await manager.is_online(session.connectorId):
        state = await read_runtime_state_from_connector(manager, session)
        if state is not None:
            await runtime_state_cache.put(state)
            return state
    cached_state = await runtime_state_cache.get(session.id)
    if cached_state is not None:
        return cached_state
    return await db.get_session_runtime_state(session.id, user_id=user_id)


async def read_session_capabilities_with_fallback(
    db: Store,
    manager: ConnectorRpcManager,
    session: SessionView,
    user_id: str | None,
) -> ProtocolCapabilitySet:
    """Read the latest session capability facts when possible.

    Side effects:
    - may perform connector RPC to the owning runtime;
    - falls back to persisted capability notifications for best-effort
      snapshot and WebSocket publish paths.
    """

    if await manager.is_online(session.connectorId):
        try:
            return await read_session_capabilities_from_connector(manager, session)
        except HTTPException:
            pass
    return ProtocolCapabilitySet.model_validate(
        await db.get_protocol_capabilities(session.connectorId, user_id=user_id)
    )


async def read_runtime_state_from_connector(
    manager: ConnectorRpcManager,
    session: SessionView,
) -> SessionRuntimeState | None:
    params: dict[str, Any] = {
        "sessionId": session.id,
        "runtime": session.runtime,
    }
    if session.externalSessionId:
        params["externalSessionId"] = session.externalSessionId
    try:
        result = await manager.request(
            session.connectorId,
            "session.state",
            params,
            timeout=10,
        )
    except (ConnectorOfflineError, ConnectorRpcError, TimeoutError):
        return None
    if not isinstance(result, dict):
        return None
    raw_state = result.get("state")
    if not isinstance(raw_state, dict):
        return None
    return runtime_state_from_rpc_payload(raw_state, session)


async def read_session_capabilities_from_connector(
    manager: ConnectorRpcManager,
    session: SessionView,
) -> ProtocolCapabilitySet:
    params: dict[str, Any] = {
        "sessionId": session.id,
        "runtime": session.runtime,
    }
    if session.externalSessionId:
        params["externalSessionId"] = session.externalSessionId
    try:
        result = await manager.request(
            session.connectorId,
            "session.capabilities",
            params,
            timeout=10,
        )
    except ConnectorOfflineError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ConnectorRpcError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": exc.code, "message": exc.message or exc.code},
        ) from exc
    if not isinstance(result, dict):
        raise HTTPException(
            status_code=502,
            detail={
                "code": "invalid_capability_set",
                "message": "connector did not return a capability set",
            },
        )
    raw_capability_set = result.get("capabilitySet")
    if not isinstance(raw_capability_set, dict):
        raise HTTPException(
            status_code=502,
            detail={
                "code": "invalid_capability_set",
                "message": "connector did not return a capability set",
            },
        )
    return ProtocolCapabilitySet.model_validate(raw_capability_set)


async def request_session_runtime_catalog(
    manager: ConnectorRpcManager,
    session: SessionView,
    method: str,
    limit: int,
) -> Any:
    """Request a runtime-level catalog for an existing session.

    Side effects:
    - sends a connector RPC request to the session's owning runtime.
    """

    try:
        return await manager.request(
            session.connectorId,
            method,
            {"runtime": session.runtime, "limit": limit},
            timeout=30,
        )
    except ConnectorOfflineError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ConnectorRpcError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": exc.code, "message": exc.message or exc.code},
        ) from exc


async def read_session_notices_from_connector(
    manager: ConnectorRpcManager,
    session: SessionView,
) -> list[NoticeIn]:
    params: dict[str, Any] = {
        "sessionId": session.id,
        "runtime": session.runtime,
    }
    if session.externalSessionId:
        params["externalSessionId"] = session.externalSessionId
    try:
        result = await manager.request(
            session.connectorId,
            "session.notices",
            params,
            timeout=10,
        )
    except ConnectorOfflineError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ConnectorRpcError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": exc.code, "message": exc.message or exc.code},
        ) from exc
    raw_notices = result.get("notices") if isinstance(result, dict) else None
    if not isinstance(raw_notices, list):
        raise HTTPException(
            status_code=502,
            detail={
                "code": "invalid_runtime_notices",
                "message": "connector did not return runtime notices",
            },
        )
    try:
        return [NoticeIn.model_validate(notice) for notice in raw_notices]
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "invalid_runtime_notices", "message": str(exc)},
        ) from exc


def runtime_state_from_rpc_payload(
    raw_state: dict[str, Any],
    session: SessionView,
) -> SessionRuntimeState:
    now = utc_now()
    return SessionRuntimeState.model_validate(
        {
            "sessionId": raw_state.get("sessionId") or session.id,
            "runtime": raw_state.get("runtime") or session.runtime,
            "externalSessionId": raw_state.get("externalSessionId")
            or session.externalSessionId,
            "status": raw_state.get("status") or "idle",
            "selections": raw_state.get("selections")
            if isinstance(raw_state.get("selections"), dict)
            else {},
            "statusReason": raw_state.get("statusReason"),
            "error": raw_state.get("error")
            if isinstance(raw_state.get("error"), dict)
            else None,
            "metadata": raw_state.get("metadata")
            if isinstance(raw_state.get("metadata"), dict)
            else {},
            "updatedSeq": session.updatedSeq,
            "createdAt": now,
            "updatedAt": now,
        }
    )


def session_with_runtime_state(
    session: SessionView,
    state: SessionRuntimeState,
) -> SessionView:
    return session.model_copy(
        update={
            "externalSessionId": state.externalSessionId or session.externalSessionId,
            "status": state.status,
        }
    )
