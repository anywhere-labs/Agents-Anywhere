"""Worker-side shared Router access and scoped device grants."""

from __future__ import annotations

import asyncio
import hashlib
import os
import secrets
import time
from collections.abc import Awaitable, Callable

from meshcall import (
    Mesh,
    MethodNotFoundError,
    ReconnectPolicy,
    RetryPolicy,
    Router,
    RouterCredentials,
)
from meshcall.router_auth import RouterScope

from agent_server.infra.connector_cleanup import complete_cleanup
from agent_server.infra.connector_control_log import control_log, error_fields
from agent_server.infra.connector_mesh_auth import ConnectorCredentialCache
from agent_server.infra.connector_mesh_contract import (
    service_names,
)
from agent_server.infra.connector_mesh_routes import (
    GRANT_TTL_SECONDS,
    MeshRoute,
    MeshRoutes,
)
from agent_server.infra.connector_rpc import (
    ConnectorNotDispatchedError,
    ConnectorOfflineError,
    ConnectorRpcManager,
)
from agent_server.infra.mesh_router import ManagedRouter
from agent_server.infra.redis_coordinator import RedisCoordinator


class ConnectorMesh:
    def __init__(self, rpc: ConnectorRpcManager, coordinator: RedisCoordinator,
                 *, credential_loader: Callable[[str], Awaitable[str]] | None = None) -> None:
        self.rpc, self.coordinator = rpc, coordinator
        self.mesh: Mesh | None = None
        self.routes = MeshRoutes(coordinator, rpc.is_connection_id_current)
        self.router_url = os.environ.get("AGENT_SERVER_MESH_URL", "")
        self.router_key = os.environ.get("AGENT_SERVER_MESH_KEY", "")
        self.router_id = os.environ.get("AGENT_SERVER_MESH_ID", "")
        self._owned_router: ManagedRouter | None = None
        self._router_lock = asyncio.Lock()
        self._closing: asyncio.Task | None = None
        self.credentials = (ConnectorCredentialCache(coordinator, credential_loader, worker_id=rpc.instance_id)
                            if credential_loader is not None else None)

    async def ensure_router(self) -> None:
        """Keep direct ASGI/uvicorn startup working, without a global singleton."""
        self._require_open()
        if self.credentials is not None:
            await self.credentials.start()
        if self.router_url:
            return
        async with self._router_lock:
            self._require_open()
            if self.router_url:
                return
            router = self._owned_router = ManagedRouter()
            try:
                # Cancelling to_thread only cancels its waiter. Retain the
                # startup owner until the thread can be stopped and joined.
                await complete_cleanup(asyncio.to_thread(router.__enter__))
                self._require_open()
                self.router_url = os.environ["AGENT_SERVER_MESH_URL"]
                self.router_key = os.environ["AGENT_SERVER_MESH_KEY"]
                self.router_id = os.environ["AGENT_SERVER_MESH_ID"]
            except BaseException:
                self._owned_router = None
                await complete_cleanup(asyncio.to_thread(router.__exit__))
                raise

    async def health(self) -> None:
        await self.ensure_router()
        if self.credentials is not None and not self.credentials.healthy:
            raise ConnectorOfflineError("credential invalidation subscription unavailable")
        await self.connection().auth.whoami()

    def _require_open(self) -> None:
        if self._closing is not None:
            raise ConnectorNotDispatchedError("server mesh transport is closing", details={
                "source": "connector_transport", "reason": "mesh_connect_failed", "deliveryState": "not_dispatched"})

    def connection(self) -> Mesh:
        self._require_open()
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
            reconnect=ReconnectPolicy(enabled=False),
            deadline_grace=0,
        )
        return self.mesh

    async def close(self) -> None:
        if self._closing is None:
            self._closing = asyncio.create_task(self._close(), name="connector-mesh-client-close")
        await complete_cleanup(self._closing)

    async def _close(self) -> None:
        try:
            if self.credentials is not None:
                await self.credentials.close()
        finally:
            try:
                mesh, self.mesh = self.mesh, None
                if mesh is not None:
                    try:
                        async with asyncio.timeout(5):
                            await mesh.close()
                    except Exception as error:  # noqa: BLE001 - the owned Router must still close
                        control_log("router.client_close_failed", level="WARNING", workerId=self.rpc.instance_id,
                                    **error_fields(error))
            finally:
                async with self._router_lock:
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
        registry = self.connection().registry
        for name in service_names(route.connector_id, route.connection_id, route.link_id).values():
            try:
                entry = await registry.describe(name)
            except MethodNotFoundError:
                return False
            if entry.name != name or not any(
                instance.id == route.link_id and not instance.draining for instance in entry.instances
            ):
                return False
        return True
