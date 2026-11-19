from __future__ import annotations

from json import JSONDecodeError
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from agent_server.api.client_forward import forward_connector, raw_body
from agent_server.api.connector_common import require_owned_connector
from agent_server.api.device_link import get_device_link_service
from agent_server.core.device_settings import (
    ConnectorDeviceSettingsPatch,
    ConnectorDeviceSettingsResponse,
)
from agent_server.core.models import (
    ArchiveAllRequest,
    ArchiveAllResponse,
    ConnectorCreateRequest,
    ConnectorCreateResponse,
    ConnectorListResponse,
    ConnectorPreferencesResponse,
    ConnectorResponse,
    ConnectorRevokeResponse,
    ConnectorUpdateRequest,
    ConnectorView,
)
from agent_server.core.protocol import ProtocolCapabilitiesResponse
from agent_server.core.utc import utc_now
from agent_server.deps import (
    agent_principal,
    current_user_id,
    get_connector_presence,
    get_device_commands,
    get_e2ee_settings,
    get_session_runtime_state_cache,
    get_store,
    get_timeline_broker,
)
from agent_server.infra.connector_presence_registry import ConnectorPresenceRegistry
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.connector_deletion import delete_connector_data
from agent_server.services.connector_device_settings import (
    get_device_settings,
    update_device_settings,
)
from agent_server.services.connector_presence import (
    with_effective_connector_status,
    with_effective_connector_statuses,
    with_effective_session_connector_statuses,
)
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_commands import DeviceCommandService
from agent_server.services.device_link import DeviceLinkService
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache

router = APIRouter(prefix="/connectors", tags=["connectors"])


@router.get("/{connector_id}/a2a/agent-card.json")
@router.post("/{connector_id}/a2a/review")
async def a2a_review(
    request: Request,
    connector_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
) -> Response:
    principal = agent_principal(request)
    if principal is None:
        raise HTTPException(403, detail={"code": "agent_scope_denied", "message": "A review delegation is required."})
    version = request.headers.get("a2a-version", "1.0")
    card = request.method == "GET"
    if not card and version != "1.0":
        return JSONResponse({
            "jsonrpc": "2.0", "id": None,
            "error": {"code": -32009, "message": "The requested A2A version is not supported."},
        })
    try:
        payload = None if card else await raw_body(request)
    except JSONDecodeError:
        return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
    return await forward_connector(
        request,
        "connector.a2a.card" if card else "connector.a2a.review",
        user_id=user_id,
        connector_id=connector_id,
        body={"payload": payload, "delegation": request.headers["authorization"].split(None, 1)[1]},
    )


@router.get("", response_model=ConnectorListResponse)
async def list_connectors(
    request: Request,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
) -> ConnectorListResponse:
    connectors = await with_effective_connector_statuses(manager, await store.list_connectors(user_id=user_id))
    principal = agent_principal(request)
    if principal is not None:
        # A delegated Agent sees the devices its delegation reaches, and only what it needs to pick one.
        mode = get_e2ee_settings(request).mode
        return JSONResponse(  # type: ignore[return-value]
            {
                "connectors": [
                    {"id": item.id, "name": item.name, "online": item.status == "online", "e2eeMode": mode}
                    for item in connectors
                    if principal.may_reach(item.id)
                ],
                "serverTime": utc_now(),
            }
        )
    return ConnectorListResponse(connectors=connectors, serverTime=utc_now())


@router.post("", response_model=ConnectorCreateResponse)
async def create_connector(
    payload: ConnectorCreateRequest,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
    links: DeviceLinkService = Depends(get_device_link_service),
) -> ConnectorCreateResponse:
    try:
        connector, token, prefix = await store.create_connector(
            name=payload.name,
            user_id=user_id,
            connector_kind=payload.connectorKind,
            installation_id=str(payload.installationId) if payload.installationId else None,
        )
    except KeyError:
        raise HTTPException(status_code=409, detail="installation was deleted; use a new installationId") from None
    if payload.installationId:
        # A registration retry reissues the credentials of an existing device: a v3 link opened
        # with the old ones ends (a no-op for a new device).
        async with store.connector_lifecycle(connector.id):
            await links.revoke(connector.id, "connector credentials reissued")
    await publish_dashboard_changed(
        store,
        broker,
        user_id=user_id,
        connector_id=connector.id,
        reason="connector.created",
    )
    return ConnectorCreateResponse(
        connector=connector, connectorToken=token, tokenPrefix=prefix
    )


@router.get("/{connector_id}", response_model=ConnectorResponse)
async def get_connector(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
) -> ConnectorResponse:
    try:
        connector = await store.get_connector(connector_id)
        if connector.userId != user_id:
            raise KeyError(connector_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    return ConnectorResponse(
        connector=await _connector_for_response(manager, connector),
        serverTime=utc_now(),
    )


@router.get(
    "/{connector_id}/protocol/capabilities",
    response_model=ProtocolCapabilitiesResponse,
    include_in_schema=False,
)
async def get_connector_protocol_capabilities(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
) -> ProtocolCapabilitiesResponse:
    try:
        connector = await store.get_connector(connector_id)
        if connector.userId != user_id:
            raise KeyError(connector_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    raise HTTPException(
        status_code=410,
        detail={
            "code": "connector_protocol_capabilities_route_removed",
            "message": (
                "Connector protocol capability reads were removed from the "
                "v2 target API."
            ),
            "use": (
                f"/connectors/{connector_id}/runtimes/{{runtimeId}}/capabilities"
            ),
        },
    )


@router.patch("/{connector_id}", response_model=ConnectorResponse)
async def update_connector(
    connector_id: str,
    payload: ConnectorUpdateRequest,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ConnectorResponse:
    try:
        connector = await store.update_connector(
            connector_id, owner_user_id=user_id, name=payload.name
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    await publish_dashboard_changed(
        store,
        broker,
        user_id=user_id,
        connector_id=connector_id,
        reason="connector.updated",
    )
    return ConnectorResponse(
        connector=await _connector_for_response(manager, connector),
        serverTime=utc_now(),
    )


@router.delete("/{connector_id}", status_code=204)
async def delete_connector(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    broker: TimelineBroker = Depends(get_timeline_broker),
    runtime_state_cache: SessionRuntimeStateCache = Depends(get_session_runtime_state_cache),
    links: DeviceLinkService = Depends(get_device_link_service),
) -> None:
    try:
        await delete_connector_data(connector_id, user_id, store, manager, runtime_state_cache, links)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    await publish_dashboard_changed(
        store,
        broker,
        user_id=user_id,
        connector_id=connector_id,
        reason="connector.deleted",
    )


@router.post("/{connector_id}/revoke", response_model=ConnectorRevokeResponse)
async def revoke_connector_token(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    broker: TimelineBroker = Depends(get_timeline_broker),
    links: DeviceLinkService = Depends(get_device_link_service),
) -> ConnectorRevokeResponse:
    async with store.connector_lifecycle(connector_id):
        try:
            connector, token, prefix = await store.rotate_connector_token(
                connector_id,
                user_id=user_id,
            )
        except KeyError:
            raise HTTPException(status_code=404, detail="connector not found") from None
        # The v3 MeshCall link first (any worker may hold it), then a v2 WebSocket.
        await links.revoke(connector_id, "connector token revoked")
        await manager.disconnect(connector_id, reason="connector token revoked")
    await publish_dashboard_changed(
        store,
        broker,
        user_id=user_id,
        connector_id=connector_id,
        reason="connector.revoked",
    )
    return ConnectorRevokeResponse(
        connector=await _connector_for_response(manager, connector),
        connectorToken=token,
        tokenPrefix=prefix,
        serverTime=utc_now(),
    )


@router.get("/{connector_id}/preferences", response_model=ConnectorPreferencesResponse)
async def get_connector_preferences(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
) -> ConnectorPreferencesResponse:
    try:
        connector = await store.get_connector(connector_id)
        if connector.userId != user_id:
            raise KeyError(connector_id)
        preferences = await store.get_connector_preferences(connector_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    return ConnectorPreferencesResponse(
        connectorId=connector_id,
        preferences=preferences,
        serverTime=utc_now(),
    )


@router.get(
    "/{connector_id}/device-settings",
    response_model=ConnectorDeviceSettingsResponse,
)
async def get_connector_device_settings(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
) -> ConnectorDeviceSettingsResponse:
    try:
        settings = await get_device_settings(store, connector_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    return ConnectorDeviceSettingsResponse(
        connectorId=connector_id,
        settings=settings,
        serverTime=utc_now(),
    )


@router.patch(
    "/{connector_id}/device-settings",
    response_model=ConnectorDeviceSettingsResponse,
)
async def patch_connector_device_settings(
    connector_id: str,
    payload: ConnectorDeviceSettingsPatch,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    commands: DeviceCommandService = Depends(get_device_commands),
) -> ConnectorDeviceSettingsResponse:
    try:
        settings, delivered = await update_device_settings(
            store, commands, connector_id, payload, user_id=user_id
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    return ConnectorDeviceSettingsResponse(
        connectorId=connector_id,
        settings=settings,
        delivered=delivered,
        serverTime=utc_now(),
    )


@router.post(
    "/{connector_id}/sessions/archive-all",
    response_model=ArchiveAllResponse,
)
async def archive_all_device_sessions(
    connector_id: str,
    payload: ArchiveAllRequest,
    store: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    user_id: str = Depends(current_user_id),
) -> ArchiveAllResponse:
    await require_owned_connector(connector_id, user_id, store)
    try:
        sessions = await store.archive_device_sessions(
            connector_id,
            payload.archived,
            scope=payload.scope,
            user_id=user_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ArchiveAllResponse(
        sessions=await with_effective_session_connector_statuses(manager, sessions),
        affected=len(sessions),
        serverTime=utc_now(),
    )


async def _connector_for_response(
    manager: ConnectorPresenceRegistry, connector: ConnectorView
) -> ConnectorView:
    return await with_effective_connector_status(manager, connector)
