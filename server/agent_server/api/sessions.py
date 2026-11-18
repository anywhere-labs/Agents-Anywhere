from __future__ import annotations

import asyncio
from collections import deque
from contextlib import nullcontext
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Body,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
)
from fastapi.responses import Response
from loguru import logger
from starlette.requests import HTTPConnection

from agent_server.api.client_forward import (
    attachment_facts,
    caller_of,
    client_path,
    forward_session,
    owned_device,
    owned_session,
    raw_body,
    session_facts,
    to_response,
)
from agent_server.api.client_forward import (
    call as client_call,
)
from agent_server.api.client_forward import (
    http_error as client_http_error,
)
from agent_server.api.device_session_reads import (
    decorate_snapshot,
    offline_snapshot,
)
from agent_server.api.server_push_websocket import (
    run_server_push_until_disconnect,
)
from agent_server.api.v2_compat import V3_SESSION_ONLY
from agent_server.core.agent_collab import MAX_ORIGIN_DEPTH
from agent_server.core.device_meshcall import (
    AttachmentRef,
    ClientServerFacts,
    DisplayEnvelope,
)
from agent_server.core.e2ee_settings import E2eeSettings, e2ee_required_error
from agent_server.core.events import (
    PORT_EVENT_TYPES,
    EventCursorError,
    event_cursor,
    parse_event_cursor,
    protocol_event,
)
from agent_server.core.models import (
    BulkArchiveResponse,
    InteractionRespondRequest,
    MessageCreateRequest,
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
    SessionSteerRequest,
    SessionView,
    TakeoverResponse,
)
from agent_server.core.protocol import (
    ProtocolCapabilitiesResponse,
    ProtocolCapabilitySet,
    ProtocolModelCatalogResponse,
    ProtocolPermissionCatalogResponse,
)
from agent_server.core.protocol_v1_2 import (
    CATCHUP_REQUIRED_EVENT,
    ProtocolEventRecoveryResponseV12,
    ProtocolSessionSnapshotResponseV12,
    ProtocolTimelineResponseV12,
)
from agent_server.core.utc import utc_now
from agent_server.deps import (
    agent_principal,
    current_user_id,
    get_catalog_service,
    get_connector_presence,
    get_device_reads,
    get_e2ee_settings,
    get_model_channel_service,
    get_session_run_service,
    get_session_runtime_state_cache,
    get_session_watch,
    get_store,
    get_timeline_broker,
    get_usage_recorder,
)
from agent_server.infra.connector_presence_registry import (
    ConnectorPresenceRegistry,
)
from agent_server.infra.event_preparation import EventPreparationCapacityError
from agent_server.infra.repositories.facade import Store
from agent_server.infra.session_watch import SessionWatchHub
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.infra.ws_tickets import ClientWsTicketManager
from agent_server.services.catalogs import CatalogService
from agent_server.services.client_forward import ClientForwardError
from agent_server.services.connector_presence import (
    with_effective_session_connector_status,
    with_effective_session_connector_statuses,
)
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_reads import DeviceReadService
from agent_server.services.effective_capabilities import (
    derive_session_effective_capabilities,
)
from agent_server.services.model_channels import ModelChannelService
from agent_server.services.session_meta_projection import (
    project_session_meta_for_dashboard,
)
from agent_server.services.session_run import SessionRunError, SessionRunService
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache
from agent_server.services.usage_events import UsageRecorder, message_sent_event

router = APIRouter(prefix="/sessions", tags=["sessions"])

_SESSION_WS_EVENT_DEDUP_LIMIT = 1_024
_SESSION_WS_LIVE_PROJECTION_EVENT_TYPES = {
    "runtime.catalog.updated",
    "runtime.queue.updated",
    "runtime.state.updated",
    "session.meta.updated",
    "port.listening",
    "port.closed",
}


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


async def _publish_session_protocol_update(
    db: Store,
    broker: TimelineBroker,
    manager: ConnectorPresenceRegistry,
    runtime_state_cache: SessionRuntimeStateCache,
    session_id: str,
) -> None:
    session = await db.get_session(session_id)
    runtime_state = await read_runtime_state_snapshot(db, runtime_state_cache, session, None)
    runtime_capabilities = ProtocolCapabilitySet.model_validate(
        await db.get_protocol_capabilities(session.connectorId, user_id=None)
    )
    next_seq = await db.get_session_seq(session_id)
    session = session_with_runtime_state(session, runtime_state)
    session = await with_effective_session_connector_status(manager, session)
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
    }
    await broker.publish(session_id, envelope)


async def _best_effort_publish_session_protocol_update(
    db: Store,
    broker: TimelineBroker,
    manager: ConnectorPresenceRegistry,
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


async def read_runtime_state_snapshot(
    db: Store,
    runtime_state_cache: SessionRuntimeStateCache,
    session: SessionView,
    user_id: str | None,
) -> SessionRuntimeState:
    """Read the runtime state a snapshot can serve without connector RPC.

    A live read is runtime-owned work that can take seconds on a large history
    (for example a DSH session log replay). Snapshot hydration therefore returns
    the newest cached or persisted fact and refreshes the live state in the
    background, where a real change is pushed to subscribers.
    """

    cached_state = await runtime_state_cache.get(session.id)
    if cached_state is not None:
        return cached_state
    return await db.get_session_runtime_state(session.id, user_id=user_id)


async def _forward_session_command(
    request: Request,
    route_id: str,
    *,
    user_id: str,
    session_id: str,
    response_model: Any,
    db: Store,
    broker: TimelineBroker,
    manager: ConnectorPresenceRegistry,
    runtime_state_cache: SessionRuntimeStateCache,
    run_service: SessionRunService | None = None,
    attachments: str | None = None,
    usage: bool = False,
) -> Response:
    """A session command through ``Client/call``.

    The Server passes the facts it owns (takeover, its records of referenced attachments), admits the command
    like its own sends, records usage once per command id and broadcasts the session's state afterwards.
    """

    session = await owned_session(request, user_id=user_id, session_id=session_id)
    body = await raw_body(request)
    refs = await attachment_facts(request, user_id=user_id, session=session, body=body, field=attachments) if (
        attachments
    ) else None
    facts = session_facts(session, **({"attachments": refs} if refs else {}))
    try:
        admission = run_service.admitted(session, user_id=user_id) if run_service is not None else nullcontext()
        async with admission:
            answer = await client_call(
                request,
                route_id,
                user_id=user_id,
                device_id=session.connectorId,
                session_id=session.id,
                body=body,
                server=facts,
                response_model=response_model,
            )
    except SessionRunError as exc:
        _raise_session_run_error(exc)
    finally:
        await _best_effort_publish_session_protocol_update(
            db, broker, manager, runtime_state_cache, session.id, user_id=user_id
        )
    if usage and answer.ok and answer.command is not None and not answer.command.replayed:
        await request.app.state.usage_recorder.record(
            message_sent_event(session, user_id=user_id, client_message_id=answer.command.command_id)
        )
    return to_response(answer)


@router.post("")
async def create_session(
    payload: SessionCreateRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
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


async def _forward_create_and_start(
    request: Request,
    payload: SessionCreateAndStartRequest,
    *,
    user_id: str,
    run_service: SessionRunService,
    manager: ConnectorPresenceRegistry,
    origin: dict[str, Any] | None = None,
) -> tuple[dict[str, Any] | None, Response | None]:
    """create-and-start through ``Client/call``: ``(result, None)`` when the device started the session,
    ``(None, response)`` with the device's own error otherwise. ``origin``: the Agent that creates it
    (``SessionOrigin``), recorded on the directory row before the device gets the creation."""

    forwarder = request.app.state.client_forwarder

    async def deliver(session: SessionView, attachments: list[dict[str, Any]], command_id: str) -> Any:
        if origin is not None:
            await request.app.state.store.set_session_origin(session.id, origin)
        body = payload.model_dump(mode="json", exclude_none=True)
        # Inline attachments are staged on the Server; the device gets their records in ``server``.
        body.pop("attachments", None)
        refs = [AttachmentRef.model_validate(item) for item in attachments]
        facts = ClientServerFacts(sessionId=session.id, takeover=True, **({"attachments": refs} if refs else {}))
        return await forwarder.call(
            "session.createAndStart",
            user_id=user_id,
            device_id=payload.connectorId,
            path=client_path(request),
            query=dict(request.query_params),
            caller=caller_of(request, user_id),
            body=body,
            server=facts,
            session_id=session.id,
            command_id=command_id,
        )

    try:
        created = await run_service.create_and_start_session(payload, user_id=user_id, deliver=deliver)
    except SessionRunError as exc:
        _raise_session_run_error(exc)
    except ClientForwardError as exc:
        raise client_http_error(exc) from exc
    answer = created["answer"]
    if not answer.ok:
        return None, to_response(answer)
    body = dict(answer.body) if isinstance(answer.body, dict) else {}
    session = created["session"]
    if origin is not None:
        # Read again: the origin was recorded after the row was created.
        session = await request.app.state.store.get_session(session.id)
    session = await with_effective_session_connector_status(manager, session)
    body["session"] = session
    body.setdefault("connectorResult", {})
    body.setdefault("attachments", created["attachments"])
    return body, None


async def _agent_origin(request: Request, db: Store, connector_id: str) -> dict[str, Any] | None:
    """The ``SessionOrigin`` of a session a delegated Agent creates, or None for a person.

    The device must be inside the delegation's scope (403 ``agent_scope_denied``) and the new session at most
    ``MAX_ORIGIN_DEPTH`` Agent-created sessions deep (403 ``agent_depth_exceeded``).
    """

    principal = agent_principal(request)
    if principal is None:
        return None
    if not principal.may_reach(connector_id):
        raise HTTPException(
            403, {"code": "agent_scope_denied", "message": "the device is outside this delegation's scope"}
        )
    depth = await db.session_origin_depth(principal.supervisor_session_id) + 1
    if depth > MAX_ORIGIN_DEPTH:
        raise HTTPException(
            403,
            {"code": "agent_depth_exceeded", "message": f"sessions created by Agents nest at most {MAX_ORIGIN_DEPTH} deep"},
        )
    return {
        "kind": "agent",
        "bySessionId": principal.supervisor_session_id,
        "byDeviceId": principal.device_id,
        "depth": depth,
    }


def _in_agent_scope(request: Request, sessions: list[SessionView]) -> list[SessionView]:
    """A delegated Agent lists only the sessions on devices its delegation reaches."""

    principal = agent_principal(request)
    if principal is None or principal.devices is None:
        return sessions
    return [session for session in sessions if principal.may_reach(session.connectorId)]


@router.post("/create-and-start")
async def create_and_start_session(
    request: Request,
    payload: SessionCreateAndStartRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> dict[str, Any]:
    # Starting a conversation on a v2 Connector would keep it on the Server (D4, D8). Adding a
    # directory entry for an existing session (``POST /sessions``) stays allowed.
    await owned_device(request, user_id=user_id, connector_id=payload.connectorId)
    origin = await _agent_origin(request, db, payload.connectorId)
    forwarded, refused = await _forward_create_and_start(
        request, payload, user_id=user_id, run_service=run_service, manager=manager, origin=origin
    )
    if refused is not None:
        return refused  # type: ignore[return-value]
    result = forwarded or {}
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
    request: Request,
    archived: bool = Query(default=False),
    limit: int = Query(default=100, ge=1, le=100),
    cursor: str | None = Query(default=None, min_length=1),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> dict[str, Any]:
    try:
        sessions, has_more, next_cursor = await db.list_sessions_page(
            archived=archived,
            limit=limit,
            cursor=cursor,
            user_id=user_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "sessions": await project_session_meta_for_dashboard(
            manager,
            runtime_state_cache,
            _in_agent_scope(request, sessions),
        ),
        "hasMore": has_more,
        "nextCursor": next_cursor,
        "serverTime": utc_now(),
    }


@router.get("/list")
async def list_session_inventory(
    request: Request,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    runtime_state_cache: SessionRuntimeStateCache = Depends(get_session_runtime_state_cache),
) -> dict[str, Any]:
    sessions = _in_agent_scope(request, await db.list_session_inventory(user_id=user_id))
    return {
        "sessions": await project_session_meta_for_dashboard(manager, runtime_state_cache, sessions),
        "serverTime": utc_now(),
    }


@router.get("/{session_id}/meta", response_model=SessionResponse)
async def get_session_meta(
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
) -> SessionResponse:
    try:
        await db.get_session(session_id, user_id=user_id)
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
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    broker: TimelineBroker = Depends(get_timeline_broker),
    e2ee: E2eeSettings = Depends(get_e2ee_settings),
) -> SessionResponse:
    # A title is content: in E2EE required mode it is only accepted sealed (display envelope), never in plaintext.
    if e2ee.required and payload.title is not None:
        raise HTTPException(status_code=409, detail=e2ee_required_error())
    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None

    if payload.displayUser is not None:
        try:
            envelope = DisplayEnvelope.model_validate(payload.displayUser)
        except ValueError:
            envelope = None
        if envelope is not None and envelope.mode == "sealed" and isinstance(envelope.payload, str):
            await db.set_session_display_user(session_id, envelope)
            session = await db.get_session(session_id, user_id=user_id)
        elif e2ee.required or envelope is None or envelope.mode != "plain":
            raise HTTPException(
                status_code=422,
                detail={"code": "display_envelope_not_sealed", "message": "displayUser must be a sealed envelope"},
            )
        else:
            # Normal mode: a plain ``{title}`` is a rename (title column and plain displayUser).
            title = envelope.payload.get("title") if isinstance(envelope.payload, dict) else None
            if not isinstance(title, str) or not title.strip() or len(title) > 255:
                raise HTTPException(
                    status_code=422,
                    detail={"code": "invalid_display_user", "message": "a plain displayUser needs a title"},
                )
            session = await db.rename_session(session_id, title, user_id=user_id)
    if payload.projectId is not None:
        try:
            session = await db.set_session_project(session_id, payload.projectId, user_id=user_id)
        except KeyError:
            raise HTTPException(
                status_code=404, detail={"code": "project_not_found", "message": "project not found"}
            ) from None
        except ValueError as exc:
            raise HTTPException(
                status_code=422, detail={"code": "project_workspace_mismatch", "message": str(exc)}
            ) from exc
    if payload.title is not None:
        try:
            session = await db.rename_session(
                session_id,
                payload.title,
                user_id=user_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    if payload.pinned is not None:
        session = await db.set_session_pinned(
            session_id,
            payload.pinned,
            user_id=user_id,
        )
    if payload.archived is not None:
        session = await db.set_session_archived(
            session_id,
            payload.archived,
            user_id=user_id,
        )

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
    manager: ConnectorPresenceRegistry,
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
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
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
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
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
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> BulkArchiveResponse:
    normalized_ids = validate_session_id_array(session_ids)
    sessions, not_found = await db.bulk_mark_sessions_read(
        normalized_ids,
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


async def _session_or_404(db: Store, session_id: str, user_id: str) -> SessionView:
    try:
        return await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None


@router.get("/{session_id}/runtime/state", response_model=SessionRuntimeStateResponse)
async def session_runtime_state(
    request: Request,
    session_id: str,
    e2ee: Annotated[E2eeSettings, Depends(get_e2ee_settings)],
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    reads: DeviceReadService = Depends(get_device_reads),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> Any:
    """Use the Server's last known state for encrypted, offline and v2 devices."""

    async def _stored_state(session: SessionView) -> dict[str, Any]:
        state = await read_runtime_state_snapshot(db, runtime_state_cache, session, user_id)
        return SessionRuntimeStateResponse(state=state, serverTime=utc_now()).model_dump(mode="json")

    session = await _session_or_404(db, session_id, user_id)
    if e2ee.required or not await reads.is_v3_device(session.connectorId):
        return await _stored_state(session)
    return await forward_session(
        request, "session.runtime.state", user_id=user_id, session_id=session_id,
        response_model=SessionRuntimeStateResponse, offline=_stored_state,
    )


@router.get("/{session_id}/runtime/capabilities", response_model=ProtocolCapabilitiesResponse)
async def session_runtime_capabilities(
    request: Request,
    session_id: str,
    e2ee: Annotated[E2eeSettings, Depends(get_e2ee_settings)],
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    reads: DeviceReadService = Depends(get_device_reads),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
) -> Any:
    """Derive capabilities from stored facts for encrypted, offline and v2 devices."""

    async def _derived(session: SessionView) -> dict[str, Any]:
        session = await with_effective_session_connector_status(manager, session)
        stored = ProtocolCapabilitySet.model_validate(
            await db.get_protocol_capabilities(session.connectorId, user_id=user_id)
        )
        capability_set = derive_session_effective_capabilities(session=session, runtime_capabilities=stored)
        return ProtocolCapabilitiesResponse(
            connectorId=session.connectorId, capabilitySet=capability_set, serverTime=utc_now()
        ).model_dump(mode="json")

    session = await _session_or_404(db, session_id, user_id)
    if e2ee.required or not await reads.is_v3_device(session.connectorId):
        return await _derived(session)
    return await forward_session(
        request, "session.runtime.capabilities", user_id=user_id, session_id=session_id,
        response_model=ProtocolCapabilitiesResponse, offline=_derived,
    )


@router.get(
    "/{session_id}/runtime/catalogs/model",
    response_model=ProtocolModelCatalogResponse,
)
async def session_runtime_model_catalog(
    request: Request,
    session_id: str,
    user_id: str = Depends(current_user_id),
    channels: ModelChannelService = Depends(get_model_channel_service),
) -> Any:
    session = await owned_session(request, user_id=user_id, session_id=session_id)

    async def _channel_overlay(body: Any) -> Any:
        parsed = ProtocolModelCatalogResponse.model_validate(body)
        catalog = await channels.channel_catalog(
            session.connectorId, _session_runtime_id(session), parsed.catalog, user_id=user_id
        )
        return ProtocolModelCatalogResponse(catalog=catalog, serverTime=utc_now()).model_dump(mode="json")

    return to_response(await client_call(
        request, "session.runtime.catalogs.model", user_id=user_id, device_id=session.connectorId,
        session_id=session.id, response_model=ProtocolModelCatalogResponse, decorate=_channel_overlay,
    ))


@router.get(
    "/{session_id}/runtime/catalogs/permission",
    response_model=ProtocolPermissionCatalogResponse,
)
async def session_runtime_permission_catalog(
    request: Request,
    session_id: str,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_session(
        request, "session.runtime.catalogs.permission", user_id=user_id, session_id=session_id,
        response_model=ProtocolPermissionCatalogResponse,
    )


@router.patch("/{session_id}/runtime/selections", response_model=SessionSelectionPatchResponse, dependencies=V3_SESSION_ONLY)
async def patch_session_selections(
    request: Request,
    session_id: str,
    payload: SessionSelectionPatchRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    db: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    broker: TimelineBroker = Depends(get_timeline_broker),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> Any:
    return await _forward_session_command(
        request, "session.runtime.selections", user_id=user_id, session_id=session_id,
        response_model=SessionSelectionPatchResponse, run_service=run_service, db=db, broker=broker, manager=manager, runtime_state_cache=runtime_state_cache,
    )


@router.get("/{session_id}/timeline", response_model=ProtocolTimelineResponseV12, dependencies=V3_SESSION_ONLY)
async def session_timeline(
    request: Request,
    session_id: str,
    after_seq: int = Query(0, alias="afterSeq", ge=0),
    before_order_seq: int | None = Query(None, alias="beforeOrderSeq", ge=1),
    mode: str = Query("latest", pattern="^(latest|changes|history)$"),
    limit: int = Query(100, ge=1, le=500),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> Any:
    """The device holds the timeline (D1); v2 sessions never get here (``V3_SESSION_ONLY``)."""

    async def _offline_timeline(session: SessionView) -> dict[str, Any]:
        fields = await db.session_directory_fields(session.id) or {}
        return ProtocolTimelineResponseV12(
            sessionId=session.id, items=[], nextSeq=int(fields.get("headSeq") or 0), hasMore=False,
            serverTime=utc_now(), historySource="unavailable", deviceOffline=True,
        ).model_dump(mode="json")

    return await forward_session(
        request, "session.timeline", user_id=user_id, session_id=session_id,
        response_model=ProtocolTimelineResponseV12, offline=_offline_timeline,
    )


# Removed migration route:
# - old: GET /sessions/{session_id}/state
# - new: GET /sessions/{session_id}/snapshot for initial aggregate hydration
# - new: GET /sessions/{session_id}/timeline for durable timeline reads
# - new: GET /sessions/{session_id}/runtime/state for live runtime state


@router.get("/{session_id}/snapshot", response_model=ProtocolSessionSnapshotResponseV12, dependencies=V3_SESSION_ONLY)
async def session_snapshot(
    request: Request,
    session_id: str,
    limit: int = Query(100, ge=1, le=500),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    catalogs: CatalogService = Depends(get_catalog_service),
    usage_recorder: UsageRecorder = Depends(get_usage_recorder),
) -> Any:
    """The snapshot through ``Client/call``: content from the device, the session view, catalogs and effective
    capabilities from the Server; an offline device gets the Server's directory facts."""

    session = await owned_session(request, user_id=user_id, session_id=session_id)
    # Opening a session is platform usage; the recorder folds quick repeats.
    await usage_recorder.touch_session_view(session, user_id=user_id)
    session = await with_effective_session_connector_status(manager, session)
    stored = ProtocolCapabilitySet.model_validate(
        await db.get_protocol_capabilities(session.connectorId, user_id=user_id)
    )
    runtime_id = _session_runtime_id(session)
    model_catalog = await catalogs.model_catalog(session.connectorId, runtime_id=runtime_id, user_id=user_id)
    permission_catalog = await catalogs.permission_catalog(session.connectorId, runtime_id=runtime_id, user_id=user_id)
    server_catalogs = {
        key: catalog.model_dump(mode="json")
        for key, catalog in (("model", model_catalog), ("permission", permission_catalog))
        if catalog is not None
    }

    def effective(runtime_capabilities: ProtocolCapabilitySet) -> ProtocolCapabilitySet:
        return derive_session_effective_capabilities(session=session, runtime_capabilities=runtime_capabilities)

    async def offline() -> dict[str, Any]:
        snapshot = await offline_snapshot(
            db=db, session=session, runtime_capabilities=stored, effective_capabilities=effective(stored),
            catalogs=server_catalogs,
        )
        return snapshot.model_dump(mode="json")

    async def decorate(body: Any) -> dict[str, Any]:
        return await decorate_snapshot(
            body, db=db, session=session, runtime_capabilities=stored, effective=effective, catalogs=server_catalogs
        )

    answer = await client_call(
        request,
        "session.snapshot",
        user_id=user_id,
        device_id=session.connectorId,
        session_id=session.id,
        response_model=ProtocolSessionSnapshotResponseV12,
        offline=offline,
        decorate=decorate,
    )
    return to_response(answer)


# Removed migration route:
# - old: GET /sessions/events/dashboard
# - new: WS /dashboard/ws


@router.get("/{session_id}/events", response_model=ProtocolEventRecoveryResponseV12, dependencies=V3_SESSION_ONLY)
async def session_events(
    request: Request,
    session_id: str,
    after: str = Query("seq:0"),
    user_id: str = Depends(current_user_id),
) -> Any:
    async def _offline_events(session: SessionView) -> dict[str, Any]:
        try:
            cursor = parse_event_cursor(after)
        except EventCursorError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return ProtocolEventRecoveryResponseV12(
            events=[], nextCursor=event_cursor(cursor), serverTime=utc_now(), deviceOffline=True
        ).model_dump(mode="json")

    return await forward_session(
        request, "session.events", user_id=user_id, session_id=session_id,
        response_model=ProtocolEventRecoveryResponseV12, offline=_offline_events,
    )


@router.websocket("/{session_id}/ws")
async def session_ws(
    websocket: WebSocket,
    session_id: str,
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    tickets: ClientWsTicketManager = Depends(_get_ws_tickets),
    reads: DeviceReadService = Depends(get_device_reads),
    session_watch: SessionWatchHub = Depends(get_session_watch),
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
        session = await db.get_session(session_id, user_id=ticket.user_id)
    except KeyError:
        await websocket.close(code=1008, reason="session not found")
        return
    device_session = await reads.is_v3_device(session.connectorId)
    # Clients that speak protocol 1.2 handle ``session.catchup_required``; older ones are
    # disconnected instead and recover through their existing reconnect-and-replay path.
    knows_catchup = _client_protocol_at_least(websocket.query_params.get("protocol"), (1, 2))

    await websocket.accept()
    queue = await broker.register(session_id)
    recovery_signal = broker.recovery_signal
    if device_session:
        await session_watch.add_subscriber(session_id, session.connectorId)

    async def send_session_updates() -> None:
        # Durable-writer and aggregate invalidations can overlap. Their
        # deterministic event IDs make duplicate delivery unnecessary on one
        # live socket; keep the cache bounded for long-running sessions.
        sent_event_ids: set[str] = set()
        sent_event_order: deque[str] = deque()
        last_live_projection_event_ids: dict[str, str] = {}
        last_capability_fingerprint: str | None = None
        if device_session:
            fields = await db.session_directory_fields(session_id) or {}
            next_seq = int(fields.get("headSeq") or 0)
        else:
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
        if device_session:
            # Clients keep no port list: tell a new subscriber what is listening now.
            previews = getattr(websocket.app.state, "previews", None)
            ports = await previews.session_ports(session.connectorId, session_id) if previews else []
            if ports:
                listening = protocol_event(
                    session_id,
                    sequence=0,
                    event_type="port.listening",
                    payload={"deviceId": session.connectorId, "ports": ports},
                )
                await websocket.send_json(listening.model_dump(mode="json"))
                last_live_projection_event_ids["port"] = listening.eventId
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), timeout=15.0)
            except TimeoutError:
                await websocket.send_json(
                    {"type": "keepalive", "serverTime": utc_now()}
                )
                continue
            try:
                prepared_events = await message.prepared_events()
            except EventPreparationCapacityError:
                await websocket.close(code=1013, reason="server busy; reconnect to recover")
                return
            for event in prepared_events:
                if event.event_type == CATCHUP_REQUIRED_EVENT and not knows_catchup:
                    if '"device_reconnected"' in event.encoded_json:
                        await websocket.close(code=1013, reason="device reconnected; reconnect to recover")
                        return
                    continue
                capability_fingerprint = event.capability_fingerprint
                if capability_fingerprint is not None:
                    if capability_fingerprint == last_capability_fingerprint:
                        continue
                    await websocket.send_text(event.encoded_json)
                    # Only mark the projection after it was delivered.  Keep
                    # capability events outside the event-id cache so an actual
                    # A -> B -> A transition remains observable even if all
                    # three projections share one durable session sequence.
                    last_capability_fingerprint = capability_fingerprint
                    continue
                if event.event_type in _SESSION_WS_LIVE_PROJECTION_EVENT_TYPES:
                    projection_key = event.event_type
                    if event.event_type in PORT_EVENT_TYPES:
                        # One projection: listening, closed, listening again are all real.
                        projection_key = "port"
                    if event.event_type == "runtime.catalog.updated":
                        projection_key = (
                            f"{event.event_type}:{event.catalog_type}"
                        )
                    if (
                        last_live_projection_event_ids.get(projection_key)
                        == event.event_id
                    ):
                        continue
                    await websocket.send_text(event.encoded_json)
                    # These are current-state projections rather than durable
                    # changes.  Adjacent duplicates are redundant, while an
                    # A -> B -> A transition at one session sequence is real.
                    last_live_projection_event_ids[projection_key] = event.event_id
                    continue
                if event.event_id in sent_event_ids:
                    continue
                await websocket.send_text(event.encoded_json)
                sent_event_ids.add(event.event_id)
                sent_event_order.append(event.event_id)
                if len(sent_event_order) > _SESSION_WS_EVENT_DEDUP_LIMIT:
                    sent_event_ids.discard(sent_event_order.popleft())

    try:
        await run_server_push_until_disconnect(
            websocket,
            send_session_updates(),
            recovery_signal=recovery_signal,
        )
    finally:
        await broker.unregister(session_id, queue)
        if device_session:
            await session_watch.remove_subscriber(session_id)


def _client_protocol_at_least(value: str | None, minimum: tuple[int, int]) -> bool:
    if not value:
        return False
    try:
        major, minor = (int(part) for part in value.split(".", 1))
    except ValueError:
        return False
    return (major, minor) >= minimum


async def _sync_device_takeover(conn: HTTPConnection, session: SessionView) -> None:
    """Takeover lives on the Server, and a v3 device needs it too (its queue dispatches only taken-over
    sessions): send it now, or when the device links again (``DeviceLinkService.push_takeover``)."""

    device_link = getattr(conn.app.state, "device_link", None)
    if device_link is None:
        return
    try:
        await device_link.push_takeover(session.connectorId, session.id)
    except Exception:  # noqa: BLE001 - the Server's value stands; the device catches up when it links again
        logger.opt(exception=True).warning("takeover sync failed session_id={}", session.id)


@router.post("/{session_id}/takeover", response_model=TakeoverResponse)
async def enable_takeover(
    session_id: str,
    conn: HTTPConnection,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    broker: TimelineBroker = Depends(get_timeline_broker),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> TakeoverResponse:
    try:
        await db.get_session(session_id, user_id=user_id)
        session = await db.set_takeover(session_id, True)
        await _sync_device_takeover(conn, session)
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
    conn: HTTPConnection,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    broker: TimelineBroker = Depends(get_timeline_broker),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> TakeoverResponse:
    try:
        await db.get_session(session_id, user_id=user_id)
        session = await db.set_takeover(session_id, False)
        await _sync_device_takeover(conn, session)
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


@router.get("/{session_id}/runtime/commands", response_model=SessionCommandListResponse, dependencies=V3_SESSION_ONLY)
async def list_session_runtime_commands(
    request: Request,
    session_id: str,
    query: str | None = Query(default=None, max_length=4096),
    limit: int = Query(default=100, ge=1, le=1000),
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_session(
        request, "session.runtime.commands", user_id=user_id, session_id=session_id,
        response_model=SessionCommandListResponse,
    )


@router.post("/{session_id}/runtime/commands", response_model=SessionCommandResponse, dependencies=V3_SESSION_ONLY)
async def execute_session_command(
    request: Request,
    session_id: str,
    payload: SessionCommandRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
) -> Any:
    return await _forward_session_command(
        request, "session.runtime.commands.execute", user_id=user_id, session_id=session_id,
        response_model=SessionCommandResponse, db=db, broker=request.app.state.timeline_broker, manager=manager,
        runtime_state_cache=request.app.state.session_runtime_state_cache,
    )


@router.post("/{session_id}/runtime/messages", response_model=RpcResponsePayload, dependencies=V3_SESSION_ONLY)
async def send_message(
    request: Request,
    session_id: str,
    payload: MessageCreateRequest,
    user_id: str = Depends(current_user_id),
    run_service: SessionRunService = Depends(get_session_run_service),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> Any:
    return await _forward_session_command(
        request, "session.runtime.messages", user_id=user_id, session_id=session_id,
        response_model=RpcResponsePayload, run_service=run_service, attachments="attachments", usage=True, db=db, broker=broker, manager=manager, runtime_state_cache=runtime_state_cache,
    )


@router.post("/{session_id}/runtime/interrupt", response_model=RpcResponsePayload, dependencies=V3_SESSION_ONLY)
async def interrupt_session(
    request: Request,
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> Any:
    return await _forward_session_command(
        request, "session.runtime.interrupt", user_id=user_id, session_id=session_id,
        response_model=RpcResponsePayload, db=db, broker=broker, manager=manager, runtime_state_cache=runtime_state_cache,
    )


@router.post("/{session_id}/runtime/steer", response_model=RpcResponsePayload, dependencies=V3_SESSION_ONLY)
async def steer_session(
    request: Request,
    session_id: str,
    payload: SessionSteerRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> Any:
    return await _forward_session_command(
        request, "session.runtime.steer", user_id=user_id, session_id=session_id,
        response_model=RpcResponsePayload, attachments="attachments", usage=True, db=db, broker=broker, manager=manager, runtime_state_cache=runtime_state_cache,
    )


@router.get("/{session_id}/runtime/notices", response_model=RuntimeNoticeListResponse, dependencies=V3_SESSION_ONLY)
async def list_session_runtime_notices(
    request: Request,
    session_id: str,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_session(
        request, "session.runtime.notices", user_id=user_id, session_id=session_id,
        response_model=RuntimeNoticeListResponse,
    )


@router.post("/{session_id}/runtime/notices/{notice_id}/respond", response_model=RpcResponsePayload, dependencies=V3_SESSION_ONLY)
async def respond_interaction(
    request: Request,
    session_id: str,
    notice_id: str,
    payload: InteractionRespondRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    runtime_state_cache: SessionRuntimeStateCache = Depends(
        get_session_runtime_state_cache
    ),
) -> Any:
    return await _forward_session_command(
        request, "session.runtime.notices.respond", user_id=user_id, session_id=session_id,
        response_model=RpcResponsePayload, db=db, broker=broker, manager=manager, runtime_state_cache=runtime_state_cache,
    )


@router.post("/{session_id}/sync", response_model=RpcResponsePayload, dependencies=V3_SESSION_ONLY)
async def sync_session(
    request: Request,
    session_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
) -> Any:
    return await _forward_session_command(
        request, "session.sync", user_id=user_id, session_id=session_id, response_model=RpcResponsePayload,
        db=db, broker=request.app.state.timeline_broker, manager=manager,
        runtime_state_cache=request.app.state.session_runtime_state_cache,
    )


def _session_runtime_id(session: SessionView) -> str:
    return session.runtimeId or session.runtime


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
