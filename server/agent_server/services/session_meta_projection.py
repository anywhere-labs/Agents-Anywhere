from __future__ import annotations

from agent_server.core.models import SessionView
from agent_server.services.connector_presence import ConnectorPresencePort
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache


async def project_session_meta_for_dashboard(
    presence: ConnectorPresencePort,
    runtime_state_cache: SessionRuntimeStateCache,
    sessions: list[SessionView],
) -> list[SessionView]:
    connector_statuses = await connector_online_statuses(presence, sessions)
    projected_sessions: list[SessionView] = []
    for session in sessions:
        connector_status = (
            "online" if connector_statuses.get(session.connectorId, False) else "offline"
        )
        projected = session.model_copy(update={"connectorStatus": connector_status})
        runtime_state = await runtime_state_cache.get(session.id)
        if runtime_state is not None:
            projected = projected.model_copy(
                update={
                    "externalSessionId": (
                        runtime_state.externalSessionId
                        or projected.externalSessionId
                    ),
                    "status": runtime_state.status,
                }
            )
        projected_sessions.append(projected)
    return projected_sessions


async def connector_online_statuses(
    presence: ConnectorPresencePort,
    sessions: list[SessionView],
) -> dict[str, bool]:
    connector_ids = [session.connectorId for session in sessions]
    batch = getattr(presence, "online_statuses", None)
    if callable(batch):
        return await batch(connector_ids)
    unique_ids = list(dict.fromkeys(connector_ids))
    return {
        connector_id: await presence.is_online(connector_id)
        for connector_id in unique_ids
    }
