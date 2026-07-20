from __future__ import annotations

from typing import Any

import asyncio
import hashlib
import json

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from starlette.requests import HTTPConnection
from starlette.responses import StreamingResponse

from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcError, ConnectorRpcManager
from agent_server.deps import (
    current_user_id,
    get_approval_service,
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
    InteractionRespondRequest,
    RpcResponsePayload,
    SessionCreateRequest,
    SessionPatchRequest,
    SessionResponse,
    SessionStateResponse,
    TakeoverResponse,
)
from agent_server.core.protocol import (
    ProtocolCapabilitySet,
    ProtocolEventEnvelope,
    ProtocolEventRecoveryResponse,
    ProtocolSessionSnapshotResponse,
    ProtocolTimelineSnapshot,
)
from agent_server.core.runtime_config import RuntimeSettingsPatchRequest, RuntimeSettingsResponse
from agent_server.services.runtime_config import RuntimeConfigService
from agent_server.services.session_run import SessionRunError, SessionRunService
from agent_server.services.approvals import ApprovalService, ApprovalServiceError
from agent_server.services.connector_presence import with_effective_session_connector_status
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.effective_capabilities import derive_session_effective_capabilities
from agent_server.services.model_catalog import build_model_catalog
from agent_server.services.permission_catalog import build_permission_catalog
from agent_server.infra.repositories.facade import Store
from agent_server.infra.ws_tickets import ClientWsTicketManager
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/sessions", tags=["sessions"])


def _get_ws_tickets(conn: HTTPConnection) -> ClientWsTicketManager:
    return conn.app.state.ws_tickets


def _raise_session_run_error(exc: SessionRunError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _approval_status_for_action(action_id: str) -> str | None:
    return {
        "approve": "approved",
        "approve_for_session": "approved_for_session",
        "reject": "rejected",
        "cancel": "cancelled",
    }.get(action_id)


def _parse_event_cursor(cursor: str) -> int:
    if cursor.startswith("seq:"):
        cursor = cursor[4:]
    try:
        return max(0, int(cursor))
    except ValueError:
        raise HTTPException(status_code=422, detail="invalid event cursor") from None


def _protocol_event(
    session_id: str,
    *,
    sequence: int,
    event_type: str,
    payload: dict[str, Any],
) -> ProtocolEventEnvelope:
    event_hash = hashlib.sha256(
        json.dumps([event_type, payload], sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:12]
    return ProtocolEventEnvelope(
        eventId=f"evt_{sequence}_{event_hash}",
        sequence=sequence,
        cursor=f"seq:{sequence}",
        type=event_type,
        sessionId=session_id,
        emittedAt=utc_now(),
        payload=payload,
    )


def _timeline_events_from_items(session_id: str, items: list[dict[str, Any]]) -> list[ProtocolEventEnvelope]:
    events: list[ProtocolEventEnvelope] = []
    for item in items:
        sequence = int(item.get("updatedSeq") or item.get("updated_seq") or 0)
        if sequence <= 0:
            continue
        revision = int(item.get("revision") or 1)
        events.append(
            _protocol_event(
                session_id,
                sequence=sequence,
                event_type="timeline.item_updated" if revision > 1 else "timeline.item_created",
                payload={"item": item},
            )
        )
    return events


def _events_from_broker_message(message: str) -> list[ProtocolEventEnvelope]:
    try:
        payload = json.loads(message)
    except json.JSONDecodeError:
        return []
    session_id = payload.get("sessionId")
    if not isinstance(session_id, str):
        return []
    events = _timeline_events_from_items(session_id, payload.get("items") if isinstance(payload.get("items"), list) else [])
    session = payload.get("session")
    if isinstance(session, dict):
        sequence = int(session.get("updatedSeq") or payload.get("nextSeq") or 0)
        if sequence > 0:
            events.append(
                _protocol_event(
                    session_id,
                    sequence=sequence,
                    event_type="session.status_changed",
                    payload={"session": session, "status": session.get("status")},
                )
            )
    notices = payload.get("notices")
    if isinstance(notices, list):
        for notice in notices:
            if not isinstance(notice, dict):
                continue
            sequence = int(notice.get("updatedSeq") or payload.get("nextSeq") or 0)
            if sequence <= 0:
                continue
            status = notice.get("status")
            event_type = "notice.created" if status == "open" and int(notice.get("revision") or 1) == 1 else "notice.updated"
            events.append(
                _protocol_event(
                    session_id,
                    sequence=sequence,
                    event_type=event_type,
                    payload={"notice": notice},
                )
            )
    if payload.get("refetch"):
        sequence = int(payload.get("nextSeq") or 0)
        if sequence > 0:
            events.append(
                _protocol_event(
                    session_id,
                    sequence=sequence,
                    event_type="session.refetch_required",
                    payload={"eventCursor": f"seq:{sequence}"},
                )
            )
    events.sort(key=lambda event: event.sequence)
    return events


async def _publish_session_protocol_update(db: Store, broker: TimelineBroker, session_id: str) -> None:
    next_seq = await db.get_session_seq(session_id)
    envelope: dict[str, Any] = {
        "sessionId": session_id,
        "nextSeq": next_seq,
        "session": (await db.get_session(session_id)).model_dump(mode="json"),
        "notices": [notice.model_dump(mode="json") for notice in await db.list_open_notices(session_id)],
    }
    await broker.publish(session_id, envelope)


async def _best_effort_publish_session_protocol_update(
    db: Store,
    broker: TimelineBroker,
    session_id: str,
    *,
    user_id: str,
) -> None:
    try:
        await db.get_session(session_id, user_id=user_id)
        await _publish_session_protocol_update(db, broker, session_id)
    except Exception:
        return


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
        session = with_effective_session_connector_status(manager, session)
        items, has_more = await db.list_timeline_latest(session_id=session_id, limit=limit)
        approvals = await db.list_pending_approvals(session_id)
        notices = await db.list_open_notices(session_id)
        next_seq = await db.get_session_seq(session_id)
        runtime_capabilities = ProtocolCapabilitySet.model_validate(
            await db.get_protocol_capabilities(session.connectorId, user_id=user_id)
        )
        defaults = await db.get_user_agent_defaults(user_id)
        runtime_defaults = defaults.get(session.runtime)
        models = (
            runtime_defaults["models"]
            if runtime_defaults and runtime_defaults.get("models")
            else await db.list_agent_models(session.runtime)
        )
        permissions = await db.list_agent_modes(session.runtime)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    effective_capabilities = derive_session_effective_capabilities(
        session=session,
        runtime_capabilities=runtime_capabilities,
    )
    return ProtocolSessionSnapshotResponse(
        session=session,
        timeline=ProtocolTimelineSnapshot(items=items, nextSeq=next_seq, hasMore=has_more),
        approvals=approvals,
        notices=notices,
        effectiveCapabilities=effective_capabilities,
        runtimeCapabilities=runtime_capabilities,
        catalogs={
            "model": build_model_catalog(runtime=session.runtime, models=models),
            "permission": build_permission_catalog(runtime=session.runtime, permissions=permissions),
        },
        eventCursor=f"seq:{next_seq}",
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
    after: str = Query("seq:0"),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> ProtocolEventRecoveryResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
        after_seq = _parse_event_cursor(after)
        items, _has_more = await db.list_timeline_since(
            session_id=session_id,
            after_seq=after_seq,
            limit=500,
        )
        notices = await db.list_open_notices(session_id)
        next_seq = await db.get_session_seq(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    events = _timeline_events_from_items(session_id, [item.model_dump(mode="json") for item in items])
    if session.updatedSeq > after_seq:
        events.append(
            _protocol_event(
                session_id,
                sequence=session.updatedSeq,
                event_type="session.status_changed",
                payload={"session": session.model_dump(mode="json"), "status": session.status},
            )
        )
    for notice in notices:
        if notice.updatedSeq > after_seq:
            events.append(
                _protocol_event(
                    session_id,
                    sequence=notice.updatedSeq,
                    event_type="notice.updated",
                    payload={"notice": notice.model_dump(mode="json")},
                )
            )
    events.sort(key=lambda event: event.sequence)
    return ProtocolEventRecoveryResponse(
        events=events,
        nextCursor=f"seq:{next_seq}",
        snapshotRequired=False,
        serverTime=utc_now(),
    )


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
    ticket = tickets.consume(ticket_value, session_id=session_id)
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
            _protocol_event(
                session_id,
                sequence=next_seq,
                event_type="session.subscribed",
                payload={"clientId": ticket.client_id, "eventCursor": f"seq:{next_seq}"},
            ).model_dump(mode="json")
        )
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), timeout=15.0)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "keepalive", "serverTime": utc_now()})
                continue
            for event in _events_from_broker_message(message):
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
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> RpcResponsePayload:
    try:
        result = await run_service.send_message(session_id, payload, user_id=user_id)
        await _publish_session_protocol_update(db, broker, session_id)
        return result
    except SessionRunError as exc:
        await _best_effort_publish_session_protocol_update(db, broker, session_id, user_id=user_id)
        _raise_session_run_error(exc)


@router.post("/{session_id}/interrupt", response_model=RpcResponsePayload)
async def interrupt_session(
    session_id: str,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> RpcResponsePayload:
    try:
        result = await run_service.interrupt_session(session_id, user_id=user_id)
        await _publish_session_protocol_update(db, broker, session_id)
        return result
    except SessionRunError as exc:
        await _best_effort_publish_session_protocol_update(db, broker, session_id, user_id=user_id)
        _raise_session_run_error(exc)


@router.post("/{session_id}/interactions/{notice_id}/respond", response_model=RpcResponsePayload)
async def respond_interaction(
    session_id: str,
    notice_id: str,
    payload: InteractionRespondRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    approval_service: ApprovalService = Depends(get_approval_service),
) -> RpcResponsePayload:
    try:
        session = await db.get_session(session_id, user_id=user_id)
        notice = await db.get_notice(notice_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="interaction not found") from None
    if notice.sessionId != session.id or notice.type != "interaction":
        raise HTTPException(status_code=404, detail="interaction not found")
    if notice.status not in {"open", "failed"}:
        raise HTTPException(status_code=409, detail="interaction is not open")
    allowed_actions = {action.actionId for action in notice.actions}
    if payload.actionId not in allowed_actions:
        raise HTTPException(status_code=422, detail="invalid interaction action")
    await db.update_notice_status(
        notice.noticeId,
        "response_accepted",
        context_patch={"response": {"actionId": payload.actionId, "input": payload.input or {}}},
    )
    if notice.interactionType == "approval":
        approval_id = notice.context.get("approvalId")
        if not isinstance(approval_id, str):
            await db.update_notice_status(notice.noticeId, "failed", context_patch={"error": "missing approval id"})
            raise HTTPException(status_code=422, detail="interaction is missing approval id")
        status = _approval_status_for_action(payload.actionId)
        if status is None:
            await db.update_notice_status(notice.noticeId, "failed", context_patch={"error": "invalid approval action"})
            raise HTTPException(status_code=422, detail="invalid approval action")
        try:
            result = await approval_service.resolve(approval_id, status, user_id=user_id)
            await _publish_session_protocol_update(db, broker, session.id)
            return result
        except ApprovalServiceError as exc:
            current_notice = await db.get_notice(notice.noticeId)
            if current_notice.status not in {"resolved", "expired", "cancelled"}:
                await db.update_notice_status(
                    notice.noticeId,
                    "failed",
                    context_patch={"error": exc.detail},
                )
            await _publish_session_protocol_update(db, broker, session.id)
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    if notice.interactionType == "execution_error":
        await db.update_notice_status(notice.noticeId, "resolved")
        await db.refresh_session_status_from_timeline(session.id)
        await _publish_session_protocol_update(db, broker, session.id)
        return RpcResponsePayload(ok=True, result={"resolved": True})
    await db.update_notice_status(notice.noticeId, "resolved")
    await db.refresh_session_status_from_timeline(session.id)
    await _publish_session_protocol_update(db, broker, session.id)
    return RpcResponsePayload(ok=True, result={"resolved": True})


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
