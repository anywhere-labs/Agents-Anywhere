from __future__ import annotations

from typing import Any

from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)


class ConnectorServiceError(RuntimeError):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


async def request_connector(
    manager: ConnectorRpcManager,
    connector_id: str,
    method: str,
    params: dict[str, Any],
    *,
    timeout: float,
) -> Any:
    try:
        return await manager.request(connector_id, method, params, timeout=timeout)
    except ConnectorOfflineError as exc:
        raise ConnectorServiceError(409, str(exc)) from exc
    except ConnectorRpcError as exc:
        raise ConnectorServiceError(502, exc.message or exc.code) from exc
    except TimeoutError as exc:
        raise ConnectorServiceError(504, f"{method} timed out") from exc
