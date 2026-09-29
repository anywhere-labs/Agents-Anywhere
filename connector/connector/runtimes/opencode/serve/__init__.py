"""OpenCode host-service peer: discovery of the shared `opencode serve` instance
and an HTTP/SSE client for its `/api` surface.

This transport replaces the in-process plugin bridge for reading sessions and
catalogs and for driving turns and approvals; see
`docs/opencode-server-surface.md` for what the host actually exposes.
"""

from connector.runtimes.opencode.serve.client import (
    OpenCodeServerClient,
    OpenCodeServiceError,
    OpenCodeServiceUnavailable,
)
from connector.runtimes.opencode.serve.mappers import (
    agent_catalog,
    model_catalog,
    platform_session_id,
    session_meta,
)
from connector.runtimes.opencode.serve.service import OpenCodeService, read_service, service_file

__all__ = [
    "OpenCodeServerClient",
    "OpenCodeService",
    "OpenCodeServiceError",
    "OpenCodeServiceUnavailable",
    "agent_catalog",
    "model_catalog",
    "platform_session_id",
    "read_service",
    "service_file",
    "session_meta",
]
