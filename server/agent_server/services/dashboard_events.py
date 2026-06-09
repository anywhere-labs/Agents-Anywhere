from __future__ import annotations

from agent_server.core.utc import utc_now
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker


async def publish_dashboard_changed(
    store: Store,
    broker: TimelineBroker,
    *,
    connector_id: str | None = None,
    session_id: str | None = None,
    user_id: str | None = None,
    reason: str = "changed",
) -> None:
    if user_id is None and connector_id is not None:
        try:
            user_id = (await store.get_connector(connector_id)).userId
        except KeyError:
            return
    if user_id is None and session_id is not None:
        try:
            session = await store.get_session(session_id)
            connector = await store.get_connector(session.connectorId)
            user_id = connector.userId
        except KeyError:
            return
    if user_id is None:
        return
    _ = reason
    payload = {"type": "dashboard.changed", "serverTime": utc_now()}
    await broker.publish_dashboard(user_id, payload)
