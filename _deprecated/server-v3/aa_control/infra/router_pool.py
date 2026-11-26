from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from typing import Any, Protocol

from loguru import logger
from meshcall import (
    Mesh,
    Router,
    RouterCredentials,
    RouterScope,
    TunnelScope,
)
from pydantic import BaseModel

from aa_control.core.config import RouterEndpoint
from aa_control.core.errors import DeviceOfflineError, UpstreamUnavailableError
from aa_control.core.models import (
    DeviceAdminCheckUpdateRequest,
    DeviceAdminCloseTunnelSessionsRequest,
    DeviceAdminPingResponse,
    DeviceAdminRenameRequest,
    EmptyRequest,
    OkResponse,
    RouterTokenEntry,
    SessionListPayload,
)
from aa_control.core.utc import unix_ms_to_iso

CONTROL_SERVICE_NAME = "aa.v3.Control"
DEVICE_ADMIN_SERVICE_NAME = "aa.v3.DeviceAdmin"
SESSIONS_SERVICE_NAME = "aa.v3.Sessions"
TERMINALS_SERVICE_NAME = "aa.v3.Terminals"
DEVICE_SERVICE_NAME = "aa.v3.Device"

TUNNEL_SCOPES: tuple[str, ...] = (
    SESSIONS_SERVICE_NAME,
    TERMINALS_SERVICE_NAME,
    DEVICE_SERVICE_NAME,
)


@dataclass(frozen=True)
class OpenedRouterTunnel:
    router_id: str
    router_url: str
    tunnel_id: str
    credential: str
    expires_at: str


class _DynamicPayload(BaseModel):
    model_config = {"extra": "allow"}


class RouterPoolPort(Protocol):
    """Port used by services to interact with one or more MeshCall Routers."""

    @property
    def router_ids(self) -> tuple[str, ...]: ...

    async def health(self) -> bool: ...

    async def issue_client_tokens(
        self,
        *,
        principal: str,
        ttl_seconds: int,
    ) -> list[RouterTokenEntry]: ...

    async def issue_device_tokens(
        self,
        *,
        device_id: str,
        principal: str,
        ttl_seconds: int,
    ) -> list[RouterTokenEntry]: ...

    async def open_tunnel(
        self,
        *,
        device_id: str,
        principal: str,
        ttl_seconds: int,
        e2e_key: str | None = None,
        preferred_router_ids: tuple[str, ...] = (),
    ) -> OpenedRouterTunnel: ...

    async def revoke_tunnel(self, tunnel_id: str) -> bool: ...

    async def call_device_admin(
        self,
        *,
        device_id: str,
        method: str,
        payload: dict[str, Any],
        timeout: float = 3.0,
    ) -> dict[str, Any]: ...

    async def call_device_sessions(
        self,
        *,
        device_id: str,
        method: str,
        payload: dict[str, Any],
        on_behalf_of: str,
        via: str,
        mcp_client: str | None = None,
        timeout: float = 3.0,
    ) -> dict[str, Any]: ...


class MeshCallRouterPool:
    """Real multi-Router MeshCall v0.4.0 pool for aa.v3.Control."""

    def __init__(self, endpoints: tuple[RouterEndpoint, ...]) -> None:
        self._endpoints = endpoints
        self._meshes: dict[str, Mesh] = {}
        self._server_tasks: list[asyncio.Task[None]] = []
        self._rr_index = 0

    @property
    def router_ids(self) -> tuple[str, ...]:
        return tuple(ep.id for ep in self._endpoints)

    async def start(self, control_service: Any | None = None) -> None:
        for ep in self._endpoints:
            creds = RouterCredentials.basic(ep.username, ep.password)
            mesh = Mesh(Router(ep.url), credentials=creds)
            await mesh.__aenter__()
            self._meshes[ep.id] = mesh
            if control_service is not None:
                host_mesh = Mesh(Router(ep.url), credentials=creds)
                host_mesh.mount(control_service)
                task = asyncio.create_task(
                    self._serve_on_router(ep.id, host_mesh),
                    name=f"aa-control-serve-{ep.id}",
                )
                self._server_tasks.append(task)
            logger.info("connected to meshcall router id={} url={}", ep.id, ep.url)

    async def _serve_on_router(self, router_id: str, host_mesh: Mesh) -> None:
        try:
            async with host_mesh.serve(access_log=False):
                await asyncio.Future()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("aa.v3.Control serving loop exited unexpectedly on router={}", router_id)

    async def stop(self) -> None:
        for task in self._server_tasks:
            task.cancel()
        for task in self._server_tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        self._server_tasks.clear()
        for mesh in self._meshes.values():
            with contextlib.suppress(Exception):
                await mesh.__aexit__(None, None, None)
        self._meshes.clear()

    async def health(self) -> bool:
        if not self._endpoints:
            return True
        if not self._meshes:
            return False
        for mesh in self._meshes.values():
            try:
                await asyncio.wait_for(mesh.auth.whoami(), timeout=2.0)
            except Exception:  # noqa: BLE001
                return False
        return True

    async def issue_client_tokens(
        self,
        *,
        principal: str,
        ttl_seconds: int,
    ) -> list[RouterTokenEntry]:
        if not self._endpoints:
            raise UpstreamUnavailableError("no MeshCall router configured")
        scopes = [RouterScope(service=CONTROL_SERVICE_NAME, methods=["*"])]
        entries: list[RouterTokenEntry] = []
        for ep in self._endpoints:
            mesh = self._meshes[ep.id]
            issued = await mesh.auth.issue_token(
                scopes=scopes,
                ttl_seconds=ttl_seconds,
                principal=principal,
            )
            entries.append(
                RouterTokenEntry(
                    router_id=ep.id,
                    router_url=ep.public_url,
                    token=issued.token,
                    token_id=issued.token_id,
                    expires_at=unix_ms_to_iso(issued.expires_at_unix_ms),
                )
            )
        return entries

    async def issue_device_tokens(
        self,
        *,
        device_id: str,
        principal: str,
        ttl_seconds: int,
    ) -> list[RouterTokenEntry]:
        if not self._endpoints:
            raise UpstreamUnavailableError("no MeshCall router configured")
        scopes = [
            RouterScope(service=SESSIONS_SERVICE_NAME, register_service=True, instance_ids=[device_id]),
            RouterScope(service=TERMINALS_SERVICE_NAME, register_service=True, instance_ids=[device_id]),
            RouterScope(service=DEVICE_SERVICE_NAME, register_service=True, instance_ids=[device_id]),
            RouterScope(service=DEVICE_ADMIN_SERVICE_NAME, register_service=True, instance_ids=[device_id]),
            RouterScope(service=CONTROL_SERVICE_NAME, methods=["presence", "notify_push"]),
        ]
        entries: list[RouterTokenEntry] = []
        for ep in self._endpoints:
            mesh = self._meshes[ep.id]
            issued = await mesh.auth.issue_token(
                scopes=scopes,
                ttl_seconds=ttl_seconds,
                principal=principal,
            )
            entries.append(
                RouterTokenEntry(
                    router_id=ep.id,
                    router_url=ep.public_url,
                    token=issued.token,
                    token_id=issued.token_id,
                    expires_at=unix_ms_to_iso(issued.expires_at_unix_ms),
                )
            )
        return entries

    def _pick_endpoint(self, preferred_router_ids: tuple[str, ...] = ()) -> RouterEndpoint:
        if not self._endpoints:
            raise UpstreamUnavailableError("no MeshCall router configured")
        candidates = [ep for ep in self._endpoints if ep.id in preferred_router_ids] if preferred_router_ids else []
        pool = candidates or list(self._endpoints)
        ep = pool[self._rr_index % len(pool)]
        self._rr_index += 1
        return ep

    async def open_tunnel(
        self,
        *,
        device_id: str,
        principal: str,
        ttl_seconds: int,
        e2e_key: str | None = None,
        preferred_router_ids: tuple[str, ...] = (),
    ) -> OpenedRouterTunnel:
        ep = self._pick_endpoint(preferred_router_ids)
        mesh = self._meshes[ep.id]
        # Intersect requested tunnel scopes with services currently registered by this instance
        # so minimal/headless Connectors (e.g. without Terminals) can still accept tunnels.
        registered_services = await mesh.registry.list()
        active_scopes = [
            TunnelScope(service=svc.name, methods=["*"])
            for svc in registered_services
            if svc.name in TUNNEL_SCOPES and any(inst.id == device_id for inst in svc.instances)
        ]
        if not active_scopes:
            raise DeviceOfflineError(f"device {device_id} has no tunnelable services registered on router {ep.id}")
        try:
            opened = await mesh.tunnels.open(
                instance=device_id,
                scopes=active_scopes,
                principal=principal,
                ttl_seconds=ttl_seconds,
                e2e_key=e2e_key,
            )
        except Exception as exc:  # noqa: BLE001
            msg = str(exc)
            if "instance_unknown" in msg or "unavailable" in msg.lower():
                raise DeviceOfflineError(f"device {device_id} is not connected to router {ep.id}") from exc
            raise UpstreamUnavailableError(f"failed to open tunnel on router {ep.id}: {msg}") from exc
        return OpenedRouterTunnel(
            router_id=ep.id,
            router_url=ep.public_url,
            tunnel_id=opened.tunnel_id,
            credential=opened.credential,
            expires_at=unix_ms_to_iso(opened.expires_at_unix_ms),
        )

    async def revoke_tunnel(self, tunnel_id: str) -> bool:
        revoked_any = False
        for mesh in self._meshes.values():
            try:
                if await mesh.tunnels.revoke(tunnel_id):
                    revoked_any = True
            except Exception:  # noqa: BLE001
                logger.warning("failed revoking tunnel={} on one router", tunnel_id)
        return revoked_any

    async def call_device_admin(
        self,
        *,
        device_id: str,
        method: str,
        payload: dict[str, Any],
        timeout: float = 3.0,
    ) -> dict[str, Any]:
        ep = self._pick_endpoint()
        mesh = self._meshes[ep.id]
        req_model: BaseModel
        resp_cls: type[BaseModel]
        if method == "ping":
            req_model = EmptyRequest()
            resp_cls = DeviceAdminPingResponse
        elif method == "close_tunnel_sessions":
            req_model = DeviceAdminCloseTunnelSessionsRequest.model_validate(payload)
            resp_cls = OkResponse
        elif method == "check_update":
            req_model = DeviceAdminCheckUpdateRequest.model_validate(payload)
            resp_cls = OkResponse
        elif method == "rename":
            req_model = DeviceAdminRenameRequest.model_validate(payload)
            resp_cls = OkResponse
        else:
            raise ValueError(f"unsupported DeviceAdmin method: {method}")
        resp = await mesh.call_unary(
            DEVICE_ADMIN_SERVICE_NAME,
            method,
            req_model,
            resp_cls,
            instance=device_id,
            timeout=timeout,
        )
        return resp.model_dump()

    async def call_device_sessions(
        self,
        *,
        device_id: str,
        method: str,
        payload: dict[str, Any],
        on_behalf_of: str,
        via: str,
        mcp_client: str | None = None,
        timeout: float = 3.0,
    ) -> dict[str, Any]:
        ep = self._pick_endpoint()
        mesh = self._meshes[ep.id]
        meta = {
            "aa-on-behalf-of": on_behalf_of,
            "aa-via": via,
        }
        if mcp_client:
            meta["aa-mcp-client"] = mcp_client
        req = _DynamicPayload.model_validate(payload)
        resp_cls: type[BaseModel] = SessionListPayload if method == "list" else _DynamicPayload
        resp = await mesh.call_unary(
            SESSIONS_SERVICE_NAME,
            method,
            req,
            resp_cls,
            instance=device_id,
            timeout=timeout,
            metadata=meta,
        )
        return resp.model_dump()
