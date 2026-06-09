from __future__ import annotations

from typing import Any

from agent_server.core.models import ConnectorView, SessionView


def effective_connector_status(manager: Any, connector_id: str) -> str:
    return "online" if manager.is_online(connector_id) else "offline"


def with_effective_connector_status(manager: Any, connector: ConnectorView) -> ConnectorView:
    status = effective_connector_status(manager, connector.id)
    if connector.status == status:
        return connector
    return connector.model_copy(update={"status": status})


def with_effective_session_connector_status(manager: Any, session: SessionView) -> SessionView:
    status = effective_connector_status(manager, session.connectorId)
    if session.connectorStatus == status:
        return session
    return session.model_copy(update={"connectorStatus": status})
