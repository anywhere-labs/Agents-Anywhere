"""Worker-side shared Router access and scoped device grants."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import os
import secrets
import time

from meshcall import Mesh, RetryPolicy, Router, RouterCredentials
from meshcall.router_auth import RouterScope

from agent_server.infra.connector_mesh_contract import (
    service_names,
)
from agent_server.infra.connector_mesh_routes import (
    GRANT_TTL_SECONDS,
    MeshRoute,
    MeshRoutes,
)
from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcManager
from agent_server.infra.mesh_router import ManagedRouter
from agent_server.infra.redis_coordinator import RedisCoordinator


class ConnectorMesh:
    def __init__(self, rpc: ConnectorRpcManager, coordinator: RedisCoordinator) -> None:
        self.rpc, self.coordinator = rpc, coordinator
        self.mesh: Mesh | None = None
        self.routes = MeshRoutes(coordinator, rpc.is_connection_id_current)
        self.router_url = os.environ.get("AGENT_SERVER_MESH_URL", "")
        self.router_key = os.environ.get("AGENT_SERVER_MESH_KEY", "")
        self.router_id = os.environ.get("AGENT_SERVER_MESH_ID", "")
        self._owned_router: ManagedRouter | None = None
        self._router_lock = asyncio.Lock()

    async def ensure_router(self) -> None:
        """Keep direct ASGI/uvicorn startup working, without a global singleton."""
        if self.router_url:
            return
        async with self._router_lock:
            if self.router_url:
                return
            self._owned_router = ManagedRouter()
            await asyncio.to_thread(self._owned_router.__enter__)
            self.router_url = os.environ["AGENT_SERVER_MESH_URL"]
            self.router_key = os.environ["AGENT_SERVER_MESH_KEY"]
            self.router_id = os.environ["AGENT_SERVER_MESH_ID"]

    async def health(self) -> None:
        await self.ensure_router()
        await self.connection().auth.whoami()

    def connection(self) -> Mesh:
        if self.mesh is not None:
            return self.mesh
        if not self.router_url:
            raise ConnectorOfflineError(
                "Start AA through python -m agent_server.main for MeshCall"
            )
        self.mesh = Mesh(
            Router(self.router_url),
            credentials=RouterCredentials.basic("server", self.router_key),
            retry=RetryPolicy(enabled=False),
            deadline_grace=0,
        )
        return self.mesh

    async def close(self) -> None:
        mesh, self.mesh = self.mesh, None
        if mesh is not None:
            with contextlib.suppress(Exception):
                await mesh.close()
        router, self._owned_router = self._owned_router, None
        if router is not None:
            await asyncio.to_thread(router.__exit__)

    async def issue(
        self, connector_id: str, connection_id: str, fingerprint: str
    ) -> dict:
        # This credential authorizes the AA proxy, not a particular Router.
        # Bootstrap and the serving WebSocket can land on different machines.
        token = secrets.token_urlsafe(32)
        link_id = f"ml_{secrets.token_urlsafe(16)}"
        names = service_names(connector_id, connection_id, link_id)
        value = {
            "connectorId": connector_id,
            "connectionId": connection_id,
            "fingerprint": fingerprint,
            "expiresAt": time.time() + GRANT_TTL_SECONDS,
            "linkId": link_id,
        }
        digest = hashlib.sha256(token.encode()).hexdigest()
        await self.routes.issue_grant(digest, value)
        return {
            "protocolVersion": "1.0",
            "path": "/api/v2/connector/mesh",
            "services": names,
            "instanceId": link_id,
            "connectionId": connection_id,
            "token": token,
            "expiresIn": GRANT_TTL_SECONDS,
        }

    @property
    def local_grants(self) -> dict[str, dict]:
        return self.routes.local_grants

    async def grant(self, token: str) -> dict | None:
        digest = hashlib.sha256(token.encode()).hexdigest()
        value = await self.routes.grant(digest)
        return value if value and value["expiresAt"] > time.time() else None

    async def authorize_router(self, grant: dict):
        """Mint a least-privilege token on the Router serving this socket."""
        await self.ensure_router()
        names = service_names(grant["connectorId"], grant["connectionId"], grant["linkId"])
        return await self.connection().auth.issue_token(
            [RouterScope(service=name, register_service=True) for name in names.values()],
            ttl_seconds=max(1, int(grant["expiresAt"] - time.time())),
        )

    def route_for(self, grant: dict) -> MeshRoute:
        return MeshRoute(
            connector_id=grant["connectorId"], connection_id=grant["connectionId"],
            link_id=grant["linkId"], router_id=self.router_id,
            worker_id=self.rpc.instance_id, generation=grant["generation"],
            owner_id=secrets.token_hex(16),
        )

    async def registered(self, route: MeshRoute) -> bool:
        names = set(service_names(route.connector_id, route.connection_id, route.link_id).values())
        services = await self.connection().registry.list()
        ready = {
            entry.name for entry in services
            if any(instance.id == route.link_id for instance in entry.instances)
        }
        return names <= ready
