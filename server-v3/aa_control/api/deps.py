from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, Request

from aa_control.core.errors import UnauthenticatedError
from aa_control.core.models import UserView
from aa_control.services.auth_service import AuthService
from aa_control.services.device_service import DeviceService
from aa_control.services.mcp_service import McpService


def get_auth_service(request: Request) -> AuthService:
    return request.app.state.auth_service


def get_device_service(request: Request) -> DeviceService:
    return request.app.state.device_service


def get_mcp_service(request: Request) -> McpService:
    return request.app.state.mcp_service


def _bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise UnauthenticatedError("missing Bearer authorization header")
    token = authorization[7:].strip()
    if not token:
        raise UnauthenticatedError("empty Bearer token")
    return token


async def current_user(
    auth: Annotated[AuthService, Depends(get_auth_service)],
    authorization: str | None = Header(default=None),
) -> UserView:
    return await auth.authenticate_access_token(_bearer_token(authorization))


def public_origin(request: Request) -> str:
    configured = request.app.state.settings.public_origin
    if configured:
        return configured.rstrip("/")
    return str(request.base_url).rstrip("/")
