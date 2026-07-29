from __future__ import annotations

from typing import Any

from agent_server.core.models import ConnectorView, SessionView


async def effective_connector_status(manager: Any, connector_id: str) -> str:
    return "online" if await manager.is_online(connector_id) else "offline"


async def with_effective_connector_status(
    manager: Any, connector: ConnectorView
) -> ConnectorView:
    status = await effective_connector_status(manager, connector.id)
    if connector.status == status:
        return connector
    return connector.model_copy(update={"status": status})


async def with_effective_session_connector_status(
    manager: Any, session: SessionView
) -> SessionView:
    status = await effective_connector_status(manager, session.connectorId)
    if session.connectorStatus == status:
        return session
    return session.model_copy(update={"connectorStatus": status})


async def with_effective_connector_statuses(
    manager: Any,
    connectors: list[ConnectorView],
) -> list[ConnectorView]:
    statuses = await _online_statuses(
        manager, [connector.id for connector in connectors]
    )
    result: list[ConnectorView] = []
    for connector in connectors:
        status = "online" if statuses[connector.id] else "offline"
        result.append(
            connector
            if connector.status == status
            else connector.model_copy(update={"status": status})
        )
    return result


async def with_effective_session_connector_statuses(
    manager: Any,
    sessions: list[SessionView],
) -> list[SessionView]:
    statuses = await _online_statuses(
        manager, [session.connectorId for session in sessions]
    )
    result: list[SessionView] = []
    for session in sessions:
        status = "online" if statuses[session.connectorId] else "offline"
        result.append(
            session
            if session.connectorStatus == status
            else session.model_copy(update={"connectorStatus": status})
        )
    return result


async def _online_statuses(manager: Any, connector_ids: list[str]) -> dict[str, bool]:
    batch = getattr(manager, "online_statuses", None)
    if callable(batch):
        return await batch(connector_ids)
    unique_ids = list(dict.fromkeys(connector_ids))
    return {
        connector_id: await manager.is_online(connector_id)
        for connector_id in unique_ids
    }
