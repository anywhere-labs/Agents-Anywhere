from __future__ import annotations

from typing import Any, Protocol

from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
)
from agent_server.services.connector_rpc import (
    ConnectorRequestTimeoutError,
    ConnectorUnavailableError,
    ConnectorUpstreamError,
)


class ConnectorRpcTransport(Protocol):
    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any: ...


class ConnectorGateway:
    """Translate Connector transport failures into application-level errors."""

    def __init__(self, manager: ConnectorRpcTransport) -> None:
        self._manager = manager

    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any:
        try:
            return await self._manager.request(
                connector_id,
                method,
                params,
                timeout=timeout,
            )
        except ConnectorOfflineError as exc:
            raise ConnectorUnavailableError(str(exc)) from exc
        except ConnectorRpcError as exc:
            raise ConnectorUpstreamError(exc.message or exc.code) from exc
        except TimeoutError as exc:
            raise ConnectorRequestTimeoutError(f"{method} timed out") from exc
