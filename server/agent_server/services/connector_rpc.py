from __future__ import annotations

from typing import Any, Protocol


class ConnectorServiceError(RuntimeError):
    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class ConnectorUnavailableError(ConnectorServiceError):
    pass


class ConnectorUpstreamError(ConnectorServiceError):
    pass


class ConnectorRequestTimeoutError(ConnectorServiceError):
    pass


class ConnectorProtocolError(ConnectorServiceError):
    pass


class ConnectorRpcPort(Protocol):
    async def request(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any: ...
