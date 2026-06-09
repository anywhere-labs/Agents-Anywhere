from __future__ import annotations

from typing import Any

from loguru import logger

from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.core.utc import utc_now


async def send_active_runtimes(
    manager: ConnectorRpcManager,
    db: Any,
    connector_id: str,
    *,
    timeout: float = 15,
) -> list[str] | None:
    try:
        runtimes = await db.get_active_runtimes(connector_id)
    except KeyError:
        logger.warning("active runtimes requested for unknown connector connector_id={}", connector_id)
        return None

    try:
        await manager.request(
            connector_id,
            "capabilities.setActiveRuntimes",
            {"runtimes": runtimes, "revision": utc_now()},
            timeout=timeout,
        )
        return runtimes
    except (ConnectorOfflineError, ConnectorRpcError, TimeoutError) as exc:
        logger.warning(
            "capabilities.setActiveRuntimes failed connector_id={} runtimes={} error={}",
            connector_id,
            runtimes,
            exc,
        )
    except Exception:
        logger.exception(
            "capabilities.setActiveRuntimes crashed connector_id={} runtimes={}",
            connector_id,
            runtimes,
        )
    return None
