from __future__ import annotations

from fastapi import HTTPException

from agent_server.core.models import ConnectorView
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store
from agent_server.services.connector_rpc import (
    ConnectorProtocolError,
    ConnectorRequestTimeoutError,
    ConnectorServiceError,
    ConnectorUnavailableError,
    ConnectorUpstreamError,
)


def raise_connector_service_error(exc: ConnectorServiceError) -> None:
    if isinstance(exc, ConnectorUnavailableError):
        status_code = 409
    elif isinstance(exc, ConnectorRequestTimeoutError):
        status_code = 504
    elif isinstance(exc, (ConnectorUpstreamError, ConnectorProtocolError)):
        status_code = 502
    else:
        status_code = 500
    raise HTTPException(status_code=status_code, detail=exc.detail) from exc


async def require_owned_connector(
    connector_id: str,
    user_id: str,
    store: Store,
) -> ConnectorView:
    try:
        connector = await store.get_connector(connector_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    if connector.userId != user_id:
        raise HTTPException(status_code=404, detail="connector not found")
    return connector


async def require_owned_online_connector(
    connector_id: str,
    user_id: str,
    store: Store,
    manager: ConnectorRpcManager,
) -> ConnectorView:
    connector = await require_owned_connector(connector_id, user_id, store)
    if not await manager.is_online(connector_id):
        raise HTTPException(status_code=409, detail="connector is offline")
    return connector


def connector_scope_id(connector_id: str) -> str:
    return f"browse_{connector_id}"
