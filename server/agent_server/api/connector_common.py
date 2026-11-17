from __future__ import annotations

from fastapi import HTTPException

from agent_server.core.models import ConnectorView
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store


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
