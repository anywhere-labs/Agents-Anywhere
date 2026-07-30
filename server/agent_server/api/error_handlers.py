from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse

from agent_server.services.connector_rpc import (
    ConnectorProtocolError,
    ConnectorRequestTimeoutError,
    ConnectorServiceError,
    ConnectorUnavailableError,
    ConnectorUpstreamError,
)
from agent_server.services.workspace import (
    WorkspaceServiceError,
    WorkspaceSessionNotFoundError,
)


async def connector_service_error_handler(
    _request: Request,
    exc: ConnectorServiceError,
) -> JSONResponse:
    if isinstance(exc, ConnectorUnavailableError):
        status_code = 409
    elif isinstance(exc, ConnectorRequestTimeoutError):
        status_code = 504
    elif isinstance(exc, (ConnectorUpstreamError, ConnectorProtocolError)):
        status_code = 502
    else:
        status_code = 500
    return JSONResponse(status_code=status_code, content={"detail": exc.detail})


async def workspace_service_error_handler(
    _request: Request,
    exc: WorkspaceServiceError,
) -> JSONResponse:
    status_code = 404 if isinstance(exc, WorkspaceSessionNotFoundError) else 409
    return JSONResponse(status_code=status_code, content={"detail": exc.detail})
