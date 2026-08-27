from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from agent_server.api.connector_common import require_owned_connector
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
    current_user_id,
    get_rpc,
    get_store,
    get_timeline_broker,
)
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.connector_presence import (
    with_effective_connector_status,
    with_effective_connector_statuses,
    with_effective_session_connector_statuses,
)
from agent_server.services.dashboard_events import publish_dashboard_changed

router = APIRouter(prefix="/connectors", tags=["connectors"])


@router.get("", response_model=ConnectorListResponse)
async def list_connectors(
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> ConnectorListResponse:
    connectors = await store.list_connectors(user_id=user_id)
    return ConnectorListResponse(
        connectors=await with_effective_connector_statuses(manager, connectors),
        serverTime=utc_now(),
    )


@router.post("", response_model=ConnectorCreateResponse)
async def create_connector(
    payload: ConnectorCreateRequest,
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ConnectorCreateResponse:
    connector, token, prefix = await store.create_connector(
        name=payload.name,
        user_id=user_id,
        connector_id=payload.connectorId,
        connector_token=payload.connectorToken,
    )
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
    manager: ConnectorRpcManager = Depends(get_rpc),
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
    manager: ConnectorRpcManager = Depends(get_rpc),
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
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> None:
    try:
        await store.revoke_connector(connector_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    await manager.disconnect(connector_id, reason="connector deleted")
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
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ConnectorRevokeResponse:
    try:
        connector, token, prefix = await store.rotate_connector_token(
            connector_id,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
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


@router.post(
    "/{connector_id}/sessions/archive-all",
    response_model=ArchiveAllResponse,
)
async def archive_all_device_sessions(
    connector_id: str,
    payload: ArchiveAllRequest,
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
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
    manager: ConnectorRpcManager, connector: ConnectorView
) -> ConnectorView:
    return await with_effective_connector_status(manager, connector)
