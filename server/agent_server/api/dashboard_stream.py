from __future__ import annotations

import asyncio
import json
from typing import Annotated, Any

from fastapi import APIRouter, Depends, WebSocket
from starlette.requests import HTTPConnection

from agent_server.api.server_push_websocket import (
    run_server_push_until_disconnect,
)
from agent_server.core.utc import utc_now
from agent_server.deps import (
    get_rpc,
    get_session_runtime_state_cache,
    get_store,
    get_timeline_broker,
)
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.infra.ws_tickets import ClientWsTicketManager
from agent_server.services.connector_presence import (
    with_effective_connector_statuses,
)
from agent_server.services.session_meta_projection import (
    project_session_meta_for_dashboard,
)
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache

router = APIRouter(prefix="/dashboard", tags=["dashboard"])
SESSION_PAGE_LIMIT = 100


def _get_ws_tickets(conn: HTTPConnection) -> ClientWsTicketManager:
    return conn.app.state.ws_tickets


async def _dashboard_snapshot(
    *,
    db: Store,
    manager: ConnectorRpcManager,
    runtime_state_cache: SessionRuntimeStateCache,
    user_id: str,
) -> dict[str, Any]:
    connectors = await db.list_connectors(user_id=user_id)
    projects = await db.list_projects(user_id=user_id)
    active_page, active_has_more, active_cursor = await db.list_sessions_page(
        archived=False,
        limit=SESSION_PAGE_LIMIT,
        user_id=user_id,
    )
    archived_page, archived_has_more, archived_cursor = await db.list_sessions_page(
        archived=True,
        limit=SESSION_PAGE_LIMIT,
        user_id=user_id,
    )
    sessions = active_page + archived_page
    sessions = await project_session_meta_for_dashboard(
        manager,
        runtime_state_cache,
        sessions,
    )
    return {
        "type": "dashboard.snapshot",
        "connectors": [
            connector.model_dump(mode="json")
            for connector in await with_effective_connector_statuses(
                manager,
                connectors,
            )
        ],
        "projects": [project.model_dump(mode="json") for project in projects],
        "sessions": [
            session.model_dump(mode="json")
            for session in sessions
        ],
        "sessionPages": {
            "active": {
                "hasMore": active_has_more,
                "nextCursor": active_cursor,
            },
            "archived": {
                "hasMore": archived_has_more,
                "nextCursor": archived_cursor,
            },
        },
        "serverTime": utc_now(),
    }


@router.websocket("/ws")
async def dashboard_ws(
    websocket: WebSocket,
    db: Annotated[Store, Depends(get_store)],
    broker: Annotated[TimelineBroker, Depends(get_timeline_broker)],
    manager: Annotated[ConnectorRpcManager, Depends(get_rpc)],
    runtime_state_cache: Annotated[
        SessionRuntimeStateCache,
        Depends(get_session_runtime_state_cache),
    ],
    tickets: Annotated[ClientWsTicketManager, Depends(_get_ws_tickets)],
) -> None:
    ticket_value = websocket.query_params.get("ticket")
    if not isinstance(ticket_value, str) or not ticket_value:
        await websocket.close(code=1008, reason="missing ticket")
        return
    ticket = await tickets.consume_scope(ticket_value, scope="dashboard")
    if ticket is None:
        await websocket.close(code=1008, reason="invalid ticket")
        return

    await websocket.accept()
    queue = await broker.register_dashboard(ticket.user_id)

    async def send_dashboard_updates() -> None:
        await websocket.send_json(
            await _dashboard_snapshot(
                db=db,
                manager=manager,
                runtime_state_cache=runtime_state_cache,
                user_id=ticket.user_id,
            )
        )
        while True:
            try:
                message = await asyncio.wait_for(queue.get(), timeout=15.0)
            except TimeoutError:
                await websocket.send_json(
                    {"type": "keepalive", "serverTime": utc_now()}
                )
                continue
            try:
                invalidation = json.loads(message)
            except json.JSONDecodeError:
                continue
            if not isinstance(invalidation, dict):
                continue
            if invalidation.get("type") != "dashboard.changed":
                continue
            await websocket.send_json(
                await _dashboard_snapshot(
                    db=db,
                    manager=manager,
                    runtime_state_cache=runtime_state_cache,
                    user_id=ticket.user_id,
                )
            )

    try:
        await run_server_push_until_disconnect(
            websocket,
            send_dashboard_updates(),
        )
    finally:
        await broker.unregister_dashboard(ticket.user_id, queue)
