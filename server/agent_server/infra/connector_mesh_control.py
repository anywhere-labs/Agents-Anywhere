"""MeshCall adapter implementing the Server's Connector request transport."""

from __future__ import annotations

import asyncio
from typing import Any

from meshcall import DeadlineExceededError, MeshCallError, UnavailableError
from pydantic import BaseModel, ConfigDict

from agent_server.infra.connector_mesh import ConnectorMesh
from agent_server.infra.connector_mesh_contract import (
    CONTROL_METHODS,
    service_names,
)
from agent_server.infra.connector_rpc import (
    ConnectorConnection,
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)


class Payload(BaseModel):
    model_config = ConfigDict(extra="allow")


class ControlRequest(BaseModel):
    request: Payload


class MeshConnectorControlTransport:
    """Route application requests to the matching Connector domain service."""

    def __init__(self, mesh: ConnectorMesh, rpc: ConnectorRpcManager) -> None:
        self.mesh = mesh
        self.rpc = rpc

    def supports(self, method: str) -> bool:
        return method in CONTROL_METHODS

    async def request_bound(
        self,
        connector_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> tuple[Any, str]:
        connection_id = await self.rpc.current_connection_id(connector_id)
        if connection_id is None:
            raise ConnectorOfflineError("connector is offline")
        result = await self._request_on_connection(
            connector_id,
            connection_id,
            method,
            params,
            timeout=timeout,
        )
        return result, connection_id

    async def request_on_connection(
        self,
        connection: ConnectorConnection,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any:
        if not await self.rpc.is_connection_id_current(
            connection.connector_id, connection.connection_id
        ):
            raise ConnectorOfflineError("connector connection was replaced")
        return await self._request_on_connection(
            connection.connector_id,
            connection.connection_id,
            method,
            params,
            timeout=timeout,
        )

    async def _request_on_connection(
        self,
        connector_id: str,
        connection_id: str,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float,
    ) -> Any:
        try:
            domain, mesh_method = CONTROL_METHODS[method]
        except KeyError as exc:
            raise ValueError(f"unsupported Connector MeshCall method: {method}") from exc
        names = service_names(connector_id, connection_id)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise TimeoutError(f"{method} timed out waiting for Connector MeshCall")
            try:
                response = await self.mesh.connection().call_unary(
                    names[domain],
                    mesh_method,
                    ControlRequest(request=Payload(**params)),
                    Payload,
                    timeout=remaining,
                    instance=connection_id,
                )
                break
            except DeadlineExceededError as exc:
                raise TimeoutError(f"{method} timed out") from exc
            except UnavailableError as exc:
                # no_instances is emitted before dispatch. It is safe to wait
                # for a just-connected device without replaying a mutation.
                details = exc.details or {}
                if (
                    details.get("source") == "router"
                    and details.get("reason") == "no_instances"
                    and await self.rpc.is_connection_id_current(
                        connector_id, connection_id
                    )
                ):
                    await asyncio.sleep(min(0.1, remaining))
                    continue
                raise ConnectorOfflineError(
                    exc.message or "connector is offline"
                ) from exc
            except MeshCallError as exc:
                raise ConnectorRpcError(exc.code, exc.message) from exc
        if not await self.rpc.is_connection_id_current(connector_id, connection_id):
            raise ConnectorOfflineError("connector connection changed")
        return response.model_dump()
