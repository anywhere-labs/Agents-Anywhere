"""Sessions on v2 Connectors under a v3 Server (D4, ``06-protocols.md`` §7).

The Server no longer stores session content (D1, D8), and a v2 Connector can only
push content into the Server. Its sessions therefore stay in the list with their
title and live status, but everything that needs the conversation answers
409 ``device_upgrade_required``: the client asks the user to upgrade Agents
Anywhere on that device.

What still works for them: list, meta (rename, pin, archive), read marks,
takeover, runtime status and capabilities, terminals.
"""

from __future__ import annotations

from fastapi import Depends, HTTPException
from starlette.requests import HTTPConnection

from agent_server.deps import current_user_id, get_device_reads, get_store
from agent_server.infra.repositories.facade import Store
from agent_server.services.device_reads import DeviceReadService

UPGRADE_REQUIRED = {
    "code": "device_upgrade_required",
    "message": "Upgrade Agents Anywhere on this device to open this session.",
}


def device_upgrade_required() -> HTTPException:
    return HTTPException(status_code=409, detail=UPGRADE_REQUIRED)


async def require_v3_connector(reads: DeviceReadService, connector_id: str) -> None:
    if not await reads.is_v3_device(connector_id):
        raise device_upgrade_required()


async def require_v3_owned_connector(db: Store, reads: DeviceReadService, connector_id: str, user_id: str) -> None:
    """Like ``require_v3_connector``; a device the caller does not own is left to the handler (404)."""

    try:
        connector = await db.get_connector(connector_id)
    except KeyError:
        return
    if connector.userId == user_id:
        await require_v3_connector(reads, connector_id)


async def v3_session_only(
    conn: HTTPConnection,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    reads: DeviceReadService = Depends(get_device_reads),
) -> None:
    """Route dependency: the session in the path must be on a v3 device.

    A session the caller does not own passes through; the handler answers 404.
    """

    session_id = conn.path_params.get("session_id")
    if not session_id:
        return
    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        return
    await require_v3_connector(reads, session.connectorId)


V3_SESSION_ONLY = [Depends(v3_session_only)]
