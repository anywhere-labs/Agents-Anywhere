"""Device link handshake for v3 devices (``contracts/device-meshcall/1.0``).

``POST /api/v3/device/auth``  -> 15-minute access token (same credentials as v2 ``/connector/auth``)
``POST /api/v3/device/hello`` -> ``LinkWelcome`` with the Router token for this device
``POST /api/v3/device/ready`` -> this worker holds ``Link/attach`` and ``Link/outbox``
"""

from __future__ import annotations

import hashlib

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from starlette.requests import HTTPConnection

from agent_server.api.connector_ingress import (
    _access_token_connector_id,
    _parse_connector_authorization,
    _require_active_connector,
)
from agent_server.core.auth import DEFAULT_EXPIRES_IN, create_connector_access_token
from agent_server.core.device_meshcall import LinkHello, LinkReady, LinkWelcome
from agent_server.core.models import ConnectorAuthResponse
from agent_server.deps import get_store
from agent_server.infra.repositories.facade import Store
from agent_server.services.device_link import DeviceLinkError, DeviceLinkService

V3_DEVICE_PREFIX = "/api/v3/device"
MESH_PATH = f"{V3_DEVICE_PREFIX}/mesh"

router = APIRouter(prefix=V3_DEVICE_PREFIX, tags=["device-link"])


class DeviceReadyResponse(BaseModel):
    connectionId: str
    held: bool = True


def get_device_link_service(conn: HTTPConnection) -> DeviceLinkService:
    return conn.app.state.device_link


def device_router_url(request: Request) -> str:
    """What devices dial: ``AGENT_SERVER_MESH_PUBLIC_URL`` or the request's own host."""

    configured = request.app.state.device_mesh.settings.public_url
    if configured:
        return configured
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    scheme = "wss" if proto in ("https", "wss") else "ws"
    return f"{scheme}://{host.split(',')[0].strip()}{MESH_PATH}"


def _raise(exc: DeviceLinkError) -> None:
    raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": exc.message}) from exc


@router.post("/auth", response_model=ConnectorAuthResponse)
async def device_auth(
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
) -> ConnectorAuthResponse:
    connector_id, token = _parse_connector_authorization(authorization)
    if not await db.verify_connector_token(connector_id, token):
        raise HTTPException(status_code=401, detail="invalid connector credential")
    return ConnectorAuthResponse(
        accessToken=create_connector_access_token(
            connector_id,
            credential_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
        ),
        expiresIn=DEFAULT_EXPIRES_IN,
    )


@router.post("/hello", response_model=LinkWelcome)
async def device_hello(
    payload: LinkHello,
    request: Request,
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
    links: DeviceLinkService = Depends(get_device_link_service),
) -> LinkWelcome:
    connector_id = _access_token_connector_id(authorization)
    async with db.connector_lifecycle(connector_id):
        await _require_active_connector(authorization, db)
        try:
            return await links.hello(connector_id, payload, router_url=device_router_url(request))
        except DeviceLinkError as exc:
            _raise(exc)
    raise AssertionError("unreachable")


@router.post("/ready", response_model=DeviceReadyResponse)
async def device_ready(
    payload: LinkReady,
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
    links: DeviceLinkService = Depends(get_device_link_service),
) -> DeviceReadyResponse:
    connector_id = _access_token_connector_id(authorization)
    # Same lock as hello and as revoking or deleting the device: a ready that passed the credential
    # check cannot finish holding the link after the device was revoked (``DeviceLinkService.revoke``
    # also removes the link record, so a later ready with this connectionId is refused).
    async with db.connector_lifecycle(connector_id):
        await _require_active_connector(authorization, db)
        try:
            await links.ready(connector_id, payload.connectionId)
        except DeviceLinkError as exc:
            _raise(exc)
    return DeviceReadyResponse(connectionId=payload.connectionId)
