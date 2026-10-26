"""Connection-scoped remote control transport; no workspace business workflow."""

from __future__ import annotations

import asyncio
import contextlib
from urllib.parse import urlsplit, urlunsplit

from meshcall import Mesh, Router, query, service
from pydantic import BaseModel

from connector.logging import logger
from connector.server.mesh_services import bind_control_services
from connector.server.urls import is_loopback_url


class Empty(BaseModel):
    pass


class ConnectionInfo(BaseModel):
    protocolVersion: str = "1.0"


def bind_connection_service(name: str):
    @service(name, targeted=True)
    class ConnectionService:
        """Probe the current transport registration without invoking business work."""

        @query(description="Check this connection's transport registration.")
        async def ping(self) -> ConnectionInfo:
            return ConnectionInfo()

    return ConnectionService()


class RemoteConnectorControl:
    def __init__(self, backend) -> None:
        self.backend = backend

    async def run(self) -> None:
        while True:
            mesh = None
            try:
                backend = self.backend
                token = await backend.ensure_access_token()
                response = await backend._get_http_client().post(
                    backend.config.server_url.rstrip("/")
                    + "/api/v2/connector/mesh/bootstrap",
                    headers={"Authorization": f"Bearer {token}"},
                    json={
                        "connectionToken": backend._mesh_connection_token,
                        "protocolVersion": "1.0",
                    },
                )
                response.raise_for_status()
                info = response.json()
                if (
                    info["protocolVersion"] != "1.0"
                    or info["connectorId"] != backend.config.connector_id
                ):
                    raise ValueError("MeshCall bootstrap identity mismatch")
                parts = urlsplit(backend.config.server_url)
                if parts.scheme not in {"http", "https"}:
                    raise ValueError("Unsupported Server URL")
                if parts.scheme == "http" and not is_loopback_url(backend.config.server_url):
                    raise ValueError("Remote MeshCall connections require HTTPS/WSS")
                url = urlunsplit((
                    "wss" if parts.scheme == "https" else "ws",
                    parts.netloc, info["path"], "", "",
                ))
                services = bind_control_services(
                    info["services"], backend._dispatcher.dispatch,
                    asyncio.get_running_loop(),
                )
                mesh = Mesh(Router(url), token=info["token"])
                mesh.mount(
                    bind_connection_service(info["services"]["Connection"]),
                    *services, instance_id=info["instanceId"], max_inflight=32,
                )
                async with mesh.serve(access_log=False, drain_timeout=0):
                    logger.info("connector MeshCall control services registered")
                    # Refresh credentials before expiry and re-bootstrap if the
                    # Router restarts, invalidating its in-memory token state.
                    for _ in range(168):
                        await asyncio.sleep(5)
                        async with asyncio.timeout(5):
                            await mesh.call_unary(
                                info["services"]["Connection"], "ping",
                                Empty(), ConnectionInfo,
                                instance=info["instanceId"], timeout=4,
                            )
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - reconnect only the transport
                logger.warning("remote control unavailable; retrying ({})", type(error).__name__)
                await asyncio.sleep(3)
            finally:
                if mesh is not None:
                    with contextlib.suppress(Exception):
                        await mesh.close()
