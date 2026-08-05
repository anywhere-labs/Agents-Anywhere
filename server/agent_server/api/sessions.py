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
from starlette.responses import StreamingResponse

from agent_server.core.events import (
    EventCursorError,
    event_cursor,
    events_from_invalidation,
    protocol_event,
)
from agent_server.core.models import (
    BulkArchiveRequest,
    BulkArchiveResponse,
    BulkReadRequest,
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
    SessionStateResponse,
    SessionView,
    SteerTurnRequest,
    TakeoverResponse,
)
from agent_server.core.protocol import (
    ProtocolCapabilitiesResponse,
    ProtocolCapabilitySet,
    ProtocolEventRecoveryResponse,
    ProtocolSessionSnapshotResponse,
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
from agent_server.services.effective_capabilities import project_session_capabilities
from agent_server.services.event_recovery import EventRecoveryService
from agent_server.services.interactions import (
    InteractionService,
    InteractionServiceError,
)
from agent_server.services.notices import pending_approvals_from_notices
from agent_server.services.session_run import SessionRunError, SessionRunService

router = APIRouter(prefix="/sessions", tags=["sessions"])


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
        session,
        user_id=None,
    )
    session = session_with_runtime_state(session, runtime_state)
    session, _runtime_capabilities, effective_capabilities = (
        await project_session_capabilities(
            db,
            manager,
            session,
        )
    )
    envelope: dict[str, Any] = {
        "sessionId": session_id,
        "nextSeq": next_seq,
        "session": session.model_dump(mode="json"),
        "state": runtime_state.model_dump(mode="json"),
        "effectiveCapabilities": effective_capabilities.model_dump(mode="json"),
        "notices": list(notices_by_id.values()),
    }
    await broker.publish(session_id, envelope)


async def _best_effort_publish_session_protocol_update(
    db: Store,
    broker: TimelineBroker,
    manager: ConnectorRpcManager,
    session_id: str,
    *,
    user_id: str | None,
) -> None:
    try:
        await db.get_session(session_id, user_id=user_id)
        await _publish_session_protocol_update(db, broker, manager, session_id)
    except Exception:
        return


async def _publish_session_protocol_changes_since(
    db: Store,
    broker: TimelineBroker,
    manager: ConnectorRpcManager,
    session_id: str,
    before_seq: int,
) -> None:
    await _publish_session_protocol_update(
        db,
        broker,
        manager,
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
        await _publish_session_protocol_update(db, broker, manager, session.id)
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


@router.patch("/{session_id}", response_model=SessionResponse)
async def patch_session(
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


@router.post("/bulk-archive", response_model=BulkArchiveResponse)
async def bulk_archive_sessions(
    payload: BulkArchiveRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> BulkArchiveResponse:
    sessions, not_found = await db.bulk_set_session_archived(
        payload.ids, payload.archived, user_id=user_id
    )
    for session in sessions:
        await publish_dashboard_changed(
            db,
            broker,
            user_id=user_id,
            connector_id=session.connectorId,
            session_id=session.id,
            reason="sessions.archived",
        )
    return BulkArchiveResponse(
        sessions=await with_effective_session_connector_statuses(manager, sessions),
        notFound=not_found,
        serverTime=utc_now(),
    )


@router.post("/bulk-read", response_model=BulkArchiveResponse)
async def bulk_mark_sessions_read(
    payload: BulkReadRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> BulkArchiveResponse:
    sessions, not_found = await db.bulk_mark_sessions_read(payload.ids, user_id=user_id)
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


@router.post("/archive", response_model=BulkArchiveResponse)
async def archive_sessions(
    session_ids: list[str] = Body(..., min_length=1, max_length=200),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> BulkArchiveResponse:
    sessions, not_found = await db.bulk_set_session_archived(
        session_ids,
        True,
        user_id=user_id,
    )
    for session in sessions:
        await publish_dashboard_changed(
            db,
            broker,
            user_id=user_id,
            connector_id=session.connectorId,
            session_id=session.id,
            reason="sessions.archived",
        )
    return BulkArchiveResponse(
        sessions=await with_effective_session_connector_statuses(manager, sessions),
        notFound=not_found,
        serverTime=utc_now(),
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


@router.post("/{session_id}/read", response_model=SessionResponse)
async def mark_session_read(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> SessionResponse:
    try:
        session = await db.mark_session_read(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    await publish_dashboard_changed(
        db,
        broker,
        user_id=user_id,
        connector_id=session.connectorId,
        session_id=session.id,
        reason="session.read",
    )
    return SessionResponse(
        session=await with_effective_session_connector_status(manager, session),
        serverTime=utc_now(),
    )


@router.get("/{session_id}/runtime/state", response_model=SessionRuntimeStateResponse)
@router.get("/{session_id}/runtime-state", response_model=SessionRuntimeStateResponse)
async def session_runtime_state(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> SessionRuntimeStateResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
        state = await read_runtime_state_live(
            db,
            manager,
            session,
            user_id=user_id,
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
    capability_set = await read_session_capabilities_from_connector(manager, session)
    return ProtocolCapabilitiesResponse(
        connectorId=session.connectorId,
        capabilitySet=capability_set,
        serverTime=utc_now(),
    )


@router.patch("/{session_id}/runtime/selections", response_model=SessionSelectionPatchResponse)
@router.patch("/{session_id}/state/selections", response_model=SessionSelectionPatchResponse)
async def patch_session_selections(
    session_id: str,
    payload: SessionSelectionPatchRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
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
        session_id,
        user_id=user_id,
    )
    return SessionSelectionPatchResponse(
        ok=True,
        state=state,
        connectorResult=connector_result,
        serverTime=utc_now(),
    )


@router.get("/{session_id}/state", response_model=SessionStateResponse)
async def session_state(
    session_id: str,
    after_seq: int = Query(0, alias="afterSeq", ge=0),
    before_order_seq: int | None = Query(None, alias="beforeOrderSeq", ge=1),
    mode: str = Query("since", pattern="^(since|latest|before)$"),
    limit: int = Query(200, ge=1, le=500),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> SessionStateResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
        if mode == "latest":
            items, has_more = await db.list_timeline_latest(session_id=session_id, limit=limit)
        elif mode == "before" or before_order_seq is not None:
            if before_order_seq is None:
                raise HTTPException(status_code=422, detail="beforeOrderSeq is required for before mode")
            items, has_more = await db.list_timeline_before_order_seq(
                session_id=session_id,
                before_order_seq=before_order_seq,
                limit=limit,
            )
        else:
            items, has_more = await db.list_timeline_since(
                session_id=session_id, after_seq=after_seq, limit=limit
            )
        approvals = pending_approvals_from_notices(
            await db.list_open_notices(session_id)
        )
        runtime_state = await read_runtime_state_live(
            db,
            manager,
            session,
            user_id=user_id,
        )
        session = session_with_runtime_state(session, runtime_state)
        next_seq = await db.get_session_seq(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    return SessionStateResponse(
        session=await with_effective_session_connector_status(manager, session),
        state=runtime_state,
        items=items,
        approvals=approvals,
        nextSeq=next_seq,
        hasMore=has_more,
        serverTime=utc_now(),
    )


@router.get("/{session_id}/snapshot", response_model=ProtocolSessionSnapshotResponse)
async def session_snapshot(
    session_id: str,
    limit: int = Query(200, ge=1, le=500),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> ProtocolSessionSnapshotResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
        session, runtime_capabilities, effective_capabilities = (
            await project_session_capabilities(
                db,
                manager,
                session,
                user_id=user_id,
            )
        )
        items, has_more = await db.list_timeline_latest(session_id=session_id, limit=limit)
        notices = await db.list_open_notices(session_id)
        approvals = pending_approvals_from_notices(notices)
        runtime_state = await read_runtime_state_live(
            db,
            manager,
            session,
            user_id=user_id,
        )
        session = session_with_runtime_state(session, runtime_state)
        _, _runtime_capabilities, effective_capabilities = (
            await project_session_capabilities(
                db,
                manager,
                session,
                user_id=user_id,
            )
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


@router.get("/events/dashboard")
async def dashboard_events(
    token: str = Query(...),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> StreamingResponse:
    from agent_server.core.auth import verify_user_access_token

    user_id = verify_user_access_token(token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="invalid user access token")

    queue = await broker.register_dashboard(user_id)

    async def stream():
        try:
            yield f'data: {{"type":"dashboard.sync","serverTime":"{utc_now()}"}}\n\n'
            while True:
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {message}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            await broker.unregister_dashboard(user_id, queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


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
) -> TakeoverResponse:
    try:
        await db.get_session(session_id, user_id=user_id)
        session = await db.set_takeover(session_id, True)
        await _publish_session_protocol_update(db, broker, manager, session_id)
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
) -> TakeoverResponse:
    try:
        await db.get_session(session_id, user_id=user_id)
        session = await db.set_takeover(session_id, False)
        await _publish_session_protocol_update(db, broker, manager, session_id)
        return TakeoverResponse(
            session=await with_effective_session_connector_status(manager, session)
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None


@router.get("/{session_id}/commands", response_model=SessionCommandListResponse)
async def list_session_commands(
    session_id: str,
    query: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=50, ge=1, le=100),
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
        "limit": limit,
    }
    if session.externalSessionId:
        params["externalSessionId"] = session.externalSessionId
    if query:
        params["query"] = query
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
@router.post("/{session_id}/commands", response_model=SessionCommandResponse)
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
@router.post("/{session_id}/messages", response_model=RpcResponsePayload)
async def send_message(
    session_id: str,
    payload: MessageCreateRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    try:
        result = await run_service.send_message(session_id, payload, user_id=user_id)
        await _publish_session_protocol_update(db, broker, manager, session_id)
        return result
    except SessionRunError as exc:
        await _best_effort_publish_session_protocol_update(
            db,
            broker,
            manager,
            session_id,
            user_id=user_id,
        )
        _raise_session_run_error(exc)


@router.post("/{session_id}/runtime/interrupt", response_model=RpcResponsePayload)
@router.post("/{session_id}/interrupt", response_model=RpcResponsePayload)
async def interrupt_session(
    session_id: str,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    try:
        before_seq = await db.get_session_seq(session_id)
        result = await run_service.interrupt_session(session_id, user_id=user_id)
        await _publish_session_protocol_changes_since(
            db,
            broker,
            manager,
            session_id,
            before_seq,
        )
        return result
    except SessionRunError as exc:
        await _best_effort_publish_session_protocol_update(
            db,
            broker,
            manager,
            session_id,
            user_id=user_id,
        )
        _raise_session_run_error(exc)


@router.post("/{session_id}/runtime/steer", response_model=RpcResponsePayload)
@router.post("/{session_id}/steer", response_model=RpcResponsePayload)
async def steer_session(
    session_id: str,
    payload: SteerTurnRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    try:
        result = await run_service.steer_session(
            session_id,
            payload,
            user_id=user_id,
        )
        await _publish_session_protocol_update(db, broker, manager, session_id)
        return result
    except SessionRunError as exc:
        await _best_effort_publish_session_protocol_update(
            db,
            broker,
            manager,
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
@router.post("/{session_id}/interactions/{notice_id}/respond", response_model=RpcResponsePayload)
async def respond_interaction(
    session_id: str,
    notice_id: str,
    payload: InteractionRespondRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    manager: ConnectorRpcManager = Depends(get_rpc),
    interaction_service: InteractionService = Depends(get_interaction_service),
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
                session_id,
                before_seq,
            )
        _raise_interaction_error(exc)
    await _publish_session_protocol_changes_since(
        db,
        broker,
        manager,
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
    session: SessionView,
    *,
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
            return state
    return await db.get_session_runtime_state(session.id, user_id=user_id)


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
