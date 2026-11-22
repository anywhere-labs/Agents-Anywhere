from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, Request

from aa_control.core.errors import ForbiddenError, UnauthenticatedError
from aa_control.core.models import UserView
from aa_control.services.assistant_service import AssistantService
from aa_control.services.auth_service import AuthService
from aa_control.services.device_service import DeviceService
from aa_control.services.drive_service import DriveCaller, DriveService
from aa_control.services.mcp_service import McpService


def get_auth_service(request: Request) -> AuthService:
    return request.app.state.auth_service


def get_device_service(request: Request) -> DeviceService:
    return request.app.state.device_service


def get_mcp_service(request: Request) -> McpService:
    return request.app.state.mcp_service


def get_drive_service(request: Request) -> DriveService:
    return request.app.state.drive_service


def get_assistant_service(request: Request) -> AssistantService:
    return request.app.state.assistant_service


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


async def current_own_session_user(
    auth: Annotated[AuthService, Depends(get_auth_service)],
    authorization: str | None = Header(default=None),
) -> UserView:
    """Require the user's own first-party login session (rejects MCP / third-party OAuth apps)."""
    token = _bearer_token(authorization)
    if token.startswith("aamcp_"):
        raise ForbiddenError(
            "Tokens Anywhere managed key is not accessible to OAuth/MCP apps",
            code="oauth_app_forbidden",
        )
    session = await auth.authenticate_access_token_session(token)
    if not session.is_first_party_session:
        raise ForbiddenError(
            "Tokens Anywhere managed key is only available to first-party user sessions",
            code="own_session_required",
        )
    return session.user


async def require_admin_user(
    user: Annotated[UserView, Depends(current_user)],
) -> UserView:
    if user.role != "admin":
        raise ForbiddenError("administrator role is required")
    return user


async def current_drive_caller(
    auth: Annotated[AuthService, Depends(get_auth_service)],
    authorization: str | None = Header(default=None),
    device_id: str | None = Header(default=None, alias="X-AA-Device-Id"),
    device_secret: str | None = Header(default=None, alias="X-AA-Device-Secret"),
) -> DriveCaller:
    if authorization:
        user = await auth.authenticate_access_token(_bearer_token(authorization))
        return DriveCaller(
            user_id=user.id,
            actor=f"user:{user.id}",
            is_admin=user.role == "admin",
            entitlements=user.entitlements,
        )
    if device_id and device_secret:
        device = await auth.authenticate_device_credentials(
            device_id=device_id.strip(),
            device_secret=device_secret.strip(),
        )
        return DriveCaller(
            user_id=device.user_id,
            actor=f"device:{device.id}",
            device_id=device.id,
            is_admin=False,
            entitlements=None,
        )
    raise UnauthenticatedError("missing Bearer authorization header or device credentials")


def public_origin(request: Request) -> str:
    configured = request.app.state.settings.public_origin
    if configured:
        return configured.rstrip("/")
    return str(request.base_url).rstrip("/")
