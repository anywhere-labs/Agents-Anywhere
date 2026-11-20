"""Authenticated bootstrap for the mobile management MeshCall service."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from meshcall import MeshCallError, RpcContext, method, service
from pydantic import Field

from agent_server.api.connector_runtimes import list_connector_runtimes
from agent_server.api.connectors import list_connectors
from agent_server.api.device_link import device_router_url, get_device_link_service
from agent_server.api.projects import list_projects
from agent_server.api.sessions import list_sessions
from agent_server.core.device_content import (
    MOBILE_CONTROL_SERVICE,
    ConnectionID,
    ContentTunnelGrant,
    DeviceID,
    EncryptedTunnelGrant,
    MobileDirectoryResource,
    MobileDirectoryResult,
)
from agent_server.core.tunnel_authorization import (
    MOBILE_CONTROL,
    mobile_control_identity,
)
from agent_server.deps import (
    current_user_claims,
    get_connector_presence,
    get_device_runtime_service,
    get_session_runtime_state_cache,
    get_store,
)
from agent_server.infra.device_mesh import DeviceCallError, MeshNotConfigured
from agent_server.infra.repositories.facade import Store
from agent_server.services.device_link import DeviceLinkError, DeviceLinkService

router = APIRouter(prefix="/api/v3/mobile", tags=["mobile-mesh"])


@service(name=MOBILE_CONTROL_SERVICE, targeted=True)
class MobileControl:
    """Only routing and authorization metadata reaches this Server instance."""

    def __init__(self, links: DeviceLinkService, request: Request, store: Store) -> None:
        self._links = links
        self._store = store
        self._presence = get_connector_presence(request)
        self._runtime_cache = get_session_runtime_state_cache(request)
        self._runtimes = get_device_runtime_service(request)
        self._app_loop = asyncio.get_running_loop()

    @staticmethod
    def _identity(ctx: RpcContext) -> tuple[str, str, str]:
        tunnel = ctx.tunnel
        identity = mobile_control_identity(tunnel.principal) if tunnel and tunnel.sealed else None
        if identity is None:
            raise MeshCallError("unauthenticated", "An encrypted mobile management tunnel is required")
        if not MOBILE_CONTROL.allows(ctx.service, ctx.method):
            raise MeshCallError("permission_denied", "Method outside mobile management scope")
        return identity

    @method(read_only=True, idempotent=True)
    async def read_directory(
        self, ctx: RpcContext, resource: MobileDirectoryResource, deviceId: DeviceID | None = None,
        cursor: Annotated[str, Field(min_length=1, max_length=2048)] | None = None,
    ) -> MobileDirectoryResult:
        """Read the authenticated account's device and workspace directory."""
        user_id, family_id, _ = self._identity(ctx)
        try:
            return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(
                self._read_directory(user_id, family_id, resource, deviceId, cursor), self._app_loop,
            ))
        except HTTPException as exc:
            raise MeshCallError(
                "unauthenticated" if exc.status_code == 401 else
                "not_found" if exc.status_code == 404 else "invalid_argument",
                "Unable to read the workspace directory", details={"httpStatus": exc.status_code},
            ) from exc

    async def _read_directory(
        self, user_id: str, family_id: str, resource: MobileDirectoryResource,
        device_id: str | None, cursor: str | None,
    ) -> MobileDirectoryResult:
        if not await self._store.token_family_status(user_id, family_id):
            raise HTTPException(401)
        if resource == "devices":
            response = await list_connectors(user_id=user_id, store=self._store, manager=self._presence)
        elif resource == "projects":
            response = await list_projects(user_id=user_id, store=self._store)
        elif resource == "sessions":
            page = await list_sessions(
                archived=False, limit=100, cursor=cursor, user_id=user_id, db=self._store,
                manager=self._presence, runtime_state_cache=self._runtime_cache,
            )
            return MobileDirectoryResult(body=page)
        elif device_id is not None:
            response = await list_connector_runtimes(device_id, service=self._runtimes, user_id=user_id)
        else:
            raise HTTPException(400)
        return MobileDirectoryResult(body=response.model_dump(mode="json"))

    @method(idempotent=False, read_only=False)
    async def issue_content_tunnel(
        self, ctx: RpcContext, deviceId: DeviceID, connectionId: ConnectionID | None = None,
    ) -> ContentTunnelGrant:
        """Issue an encrypted tunnel ending at the authorized Connector."""
        user_id, family_id, router_url = self._identity(ctx)
        try:
            # MeshCall dispatches on its own loop. The store and issuer belong to ASGI.
            return await asyncio.wrap_future(
                asyncio.run_coroutine_threadsafe(
                    self._links.open_content_tunnel(
                        deviceId,
                        user_id=user_id,
                        family_id=family_id,
                        router_url=router_url,
                        expected_connection=connectionId,
                    ),
                    self._app_loop,
                ),
            )
        except DeviceLinkError as exc:
            raise MeshCallError(
                exc.code, exc.message, details={"httpStatus": exc.status}, retryable=exc.status == 503,
            ) from exc


@router.post("/control-tunnel", response_model=EncryptedTunnelGrant)
async def bootstrap_mobile_control(
    request: Request,
    response: Response,
    claims: Annotated[tuple[str, str | None], Depends(current_user_claims)],
    links: Annotated[DeviceLinkService, Depends(get_device_link_service)],
    store: Annotated[Store, Depends(get_store)],
) -> EncryptedTunnelGrant:
    user_id, family_id = claims
    if family_id is None:
        raise HTTPException(status_code=401, detail="Sign in again to establish a login session")
    mesh = request.app.state.device_mesh
    try:
        grant = await mesh.open_mobile_control_tunnel(
            MobileControl(links, request, store), user_id=user_id, family_id=family_id,
            public_router_url=device_router_url(request),
        )
    except (DeviceCallError, MeshNotConfigured) as exc:
        raise HTTPException(
            status_code=503, detail={"code": "mobile_control_unavailable"},
        ) from exc
    if not await store.token_family_status(user_id, family_id):
        await mesh.revoke_content_tunnel(grant.tunnel_id)
        raise HTTPException(status_code=401, detail={"code": "login_revoked"})
    response.headers["Cache-Control"] = "no-store"
    return grant
