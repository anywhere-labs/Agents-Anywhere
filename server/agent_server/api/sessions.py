from __future__ import annotations

from typing import Any

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query
from starlette.responses import StreamingResponse

from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcError, ConnectorRpcManager
from agent_server.deps import (
    current_user_id,
    get_rpc,
    get_runtime_config_service,
    get_session_run_service,
    get_store,
    get_timeline_broker,
)
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.core.models import (
    BulkArchiveRequest,
    BulkArchiveResponse,
    BulkReadRequest,
    MessageCreateRequest,
    RpcResponsePayload,
    SessionCreateRequest,
    SessionPatchRequest,
    SessionResponse,
    SessionStateResponse,
    TakeoverResponse,
)
from agent_server.core.runtime_config import RuntimeSettingsPatchRequest, RuntimeSettingsResponse
from agent_server.services.runtime_config import RuntimeConfigService
from agent_server.services.session_run import SessionRunError, SessionRunService
from agent_server.services.connector_presence import with_effective_session_connector_status
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.infra.repositories.facade import Store
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/sessions", tags=["sessions"])


def _raise_session_run_error(exc: SessionRunError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


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
            "session": with_effective_session_connector_status(manager, session),
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


@router.get("")
async def list_sessions(
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> dict[str, Any]:
    sessions = await db.list_sessions(user_id=user_id)
    return {
        "sessions": [with_effective_session_connector_status(manager, session) for session in sessions],
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
        session=with_effective_session_connector_status(manager, session),
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
        sessions=[with_effective_session_connector_status(manager, session) for session in sessions],
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
        sessions=[with_effective_session_connector_status(manager, session) for session in sessions],
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
        session=with_effective_session_connector_status(manager, session),
        serverTime=utc_now(),
    )


@router.get("/{session_id}/state", response_model=SessionStateResponse)
async def session_state(
    session_id: str,
    after_seq: int = Query(0, alias="afterSeq", ge=0),
    limit: int = Query(200, ge=1, le=500),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> SessionStateResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
        items, has_more = await db.list_timeline_since(
            session_id=session_id, after_seq=after_seq, limit=limit
        )
        approvals = await db.list_pending_approvals(session_id)
        next_seq = await db.get_session_seq(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    return SessionStateResponse(
        session=with_effective_session_connector_status(manager, session),
        items=items,
        approvals=approvals,
        nextSeq=next_seq,
        hasMore=has_more,
        serverTime=utc_now(),
    )


@router.get("/{session_id}/runtime-settings", response_model=RuntimeSettingsResponse)
async def get_session_runtime_settings(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    runtime_config: RuntimeConfigService = Depends(get_runtime_config_service),
) -> RuntimeSettingsResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
        effective = await runtime_config.get_effective_runtime_settings(
            session_id,
            user_id=user_id,
        )
        override = await runtime_config.get_session_runtime_settings_override(
            session_id,
            user_id=user_id,
        )
        schema = await runtime_config.get_runtime_config_schema(session.runtime)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return RuntimeSettingsResponse(
        sessionId=session_id,
        runtime=session.runtime,
        settings=effective,
        runtimeSettings=effective,
        runtimeSettingsOverride=override,
        schemaVersion=schema.schemaVersion,
        serverTime=utc_now(),
    )


@router.patch("/{session_id}/runtime-settings", response_model=RuntimeSettingsResponse)
async def patch_session_runtime_settings(
    session_id: str,
    payload: RuntimeSettingsPatchRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    runtime_config: RuntimeConfigService = Depends(get_runtime_config_service),
) -> RuntimeSettingsResponse:
    try:
        override = await runtime_config.patch_session_runtime_settings(
            session_id,
            payload.settings,
            user_id=user_id,
        )
        session = await db.get_session(session_id, user_id=user_id)
        effective = await runtime_config.get_effective_runtime_settings(
            session_id,
            user_id=user_id,
        )
        schema = await runtime_config.get_runtime_config_schema(session.runtime)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return RuntimeSettingsResponse(
        sessionId=session_id,
        runtime=session.runtime,
        settings=effective,
        runtimeSettings=effective,
        runtimeSettingsOverride=override,
        schemaVersion=schema.schemaVersion,
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
    token: str = Query(...),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> StreamingResponse:
    """SSE push channel. Browser EventSource can't set custom headers, so the
    user access token comes in via ?token=… query param. Each event is a JSON
    envelope `{sessionId, nextSeq}`; the client refetches the incremental
    state on receipt — that keeps the cursor authoritative and survives
    dropped events.
    """
    from agent_server.core.auth import verify_user_access_token

    user_id = verify_user_access_token(token)
    if user_id is None:
        raise HTTPException(status_code=401, detail="invalid user access token")
    try:
        await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None

    queue = await broker.register(session_id)

    async def stream():
        try:
            # Initial frame asks the client to reconcile via one GET /state.
            # This covers both first connect and every auto-reconnect (catch up
            # whatever was missed while the SSE was down). Steady-state events
            # afterwards carry item payloads directly — no refetch.
            next_seq = await db.get_session_seq(session_id)
            yield f'data: {{"sessionId":"{session_id}","nextSeq":{next_seq},"refetch":true}}\n\n'
            while True:
                try:
                    # 15s heartbeat upper bound prevents proxies/clients from
                    # closing an idle connection.
                    message = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {message}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            await broker.unregister(session_id, queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/{session_id}/takeover", response_model=TakeoverResponse)
async def enable_takeover(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> TakeoverResponse:
    try:
        await db.get_session(session_id, user_id=user_id)
        session = await db.set_takeover(session_id, True)
        return TakeoverResponse(session=with_effective_session_connector_status(manager, session))
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None


@router.delete("/{session_id}/takeover", response_model=TakeoverResponse)
async def disable_takeover(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> TakeoverResponse:
    try:
        await db.get_session(session_id, user_id=user_id)
        session = await db.set_takeover(session_id, False)
        return TakeoverResponse(session=with_effective_session_connector_status(manager, session))
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None


@router.post("/{session_id}/messages", response_model=RpcResponsePayload)
async def send_message(
    session_id: str,
    payload: MessageCreateRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
) -> RpcResponsePayload:
    try:
        return await run_service.send_message(session_id, payload, user_id=user_id)
    except SessionRunError as exc:
        _raise_session_run_error(exc)


@router.post("/{session_id}/interrupt", response_model=RpcResponsePayload)
async def interrupt_session(
    session_id: str,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
) -> RpcResponsePayload:
    try:
        return await run_service.interrupt_session(session_id, user_id=user_id)
    except SessionRunError as exc:
        _raise_session_run_error(exc)


@router.post("/{session_id}/sync", response_model=RpcResponsePayload)
async def sync_session(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    if not manager.is_online(session.connectorId):
        raise HTTPException(status_code=409, detail="connector is offline")
    if not session.externalSessionId:
        raise HTTPException(status_code=409, detail="session has no external runtime id")
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
