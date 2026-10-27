"""Connection-scoped remote control transport; no workspace business workflow."""

from __future__ import annotations

import asyncio
import contextlib
from urllib.parse import urlsplit, urlunsplit

from meshcall import Mesh, ReconnectPolicy, RetryPolicy, Router, query, service
from pydantic import BaseModel

from connector.server.control_log import control_log, error_fields
from connector.server.mesh_services import (
    ConnectorControlExecutor,
    bind_control_services,
)
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
        self.executor = ConnectorControlExecutor(
            backend._dispatcher.dispatch, connector_id=getattr(backend.config, "connector_id", ""),
        )

    async def run(self, request_session=None) -> None:
        dispatch = request_session.dispatch if request_session is not None else self.backend._dispatcher.dispatch
        self.executor.open_session(dispatch, self.backend._mesh_connection_token)
        try:
            await self._serve()
        finally:
            # Match the legacy channel: a caller deadline does not cancel work,
            # but ending the base Connector connection cancels its queued/tasks.
            await self.executor.close_session()

    async def _serve(self) -> None:
        while True:
            mesh = None
            phase = "bootstrap"
            fields = {"connectorId": self.executor.connector_id}
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
                fields.update(connectionId=info.get("connectionId"), linkId=info.get("instanceId"))
                phase = "register_services"
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
                    executor=self.executor,
                )
                mesh = Mesh(Router(url), token=info["token"],
                            retry=RetryPolicy(enabled=False), reconnect=ReconnectPolicy(enabled=False))
                mesh.mount(
                    bind_connection_service(info["services"]["Connection"]),
                    *services, instance_id=info["instanceId"],
                )
                async with mesh.serve(access_log=False, drain_timeout=0):
                    control_log("link.registered", **fields)
                    phase = "monitor_registration"
                    # A second Mesh client socket could land on another Router.
                    # Query the shared route via HTTP instead; losing the serve
                    # link or its Router makes this route disappear.
                    registered = False
                    for index in range(168):
                        await asyncio.sleep(5)
                        status = await backend._get_http_client().get(
                            backend.config.server_url.rstrip("/") + "/api/v2/connector/mesh/status",
                            headers={"Authorization": f"Bearer {info['token']}"}, timeout=5,
                        )
                        status.raise_for_status()
                        ready = status.json().get("ready") is True
                        if not ready and (registered or index >= 1):
                            control_log("link.reconnecting", level="WARNING", **fields,
                                        reason="registration_lost" if registered else "registration_not_ready")
                            break
                        registered = ready
                    else:
                        control_log("link.refresh", **fields, reason="credential_refresh")
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - reconnect only the transport
                control_log("link.retry", level="WARNING", **fields, phase=phase, **error_fields(error))
                await asyncio.sleep(3)
            finally:
                if mesh is not None:
                    with contextlib.suppress(Exception):
                        await mesh.close()
