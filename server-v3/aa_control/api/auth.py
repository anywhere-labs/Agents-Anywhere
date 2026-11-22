from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from aa_control.api.deps import current_user, get_auth_service, get_device_service
from aa_control.core.models import (
    AuthConfigResponse,
    AuthTokenResponse,
    ClientPlatform,
    ClientRouterTokenRequest,
    ClientRouterTokenResponse,
    DeviceRouterTokenRequest,
    DeviceRouterTokenResponse,
    LoginRequest,
    LogoutRequest,
    OkResponse,
    RefreshRequest,
    RegisterDeviceRequest,
    RegisterDeviceResponse,
    RegisterRequest,
    UserView,
)
from aa_control.services.auth_service import AuthService
from aa_control.services.device_service import DeviceService

router = APIRouter(tags=["auth"])


class OAuthStartResponse(BaseModel):
    authorize_url: str
    state: str


class OAuthCallbackRequest(BaseModel):
    code: str
    redirect_uri: str
    client_id: str | None = None
    client_platform: ClientPlatform = "web"


@router.get("/auth/config", response_model=AuthConfigResponse)
async def auth_config(auth: Annotated[AuthService, Depends(get_auth_service)]) -> AuthConfigResponse:
    return await auth.auth_config()


@router.post("/auth/register", response_model=AuthTokenResponse)
async def register(
    payload: RegisterRequest,
    auth: Annotated[AuthService, Depends(get_auth_service)],
) -> AuthTokenResponse:
    return await auth.register(payload)


@router.post("/auth/login", response_model=AuthTokenResponse)
async def login(
    payload: LoginRequest,
    auth: Annotated[AuthService, Depends(get_auth_service)],
) -> AuthTokenResponse:
    return await auth.login(payload)


@router.post("/auth/refresh", response_model=AuthTokenResponse)
async def refresh(
    payload: RefreshRequest,
    auth: Annotated[AuthService, Depends(get_auth_service)],
) -> AuthTokenResponse:
    return await auth.refresh(payload.refresh_token)


@router.post("/auth/logout", response_model=OkResponse)
async def logout(
    payload: LogoutRequest,
    auth: Annotated[AuthService, Depends(get_auth_service)],
) -> OkResponse:
    await auth.logout(payload.refresh_token)
    return OkResponse(ok=True)


@router.get("/auth/me", response_model=UserView)
async def me(user: Annotated[UserView, Depends(current_user)]) -> UserView:
    return user


@router.get("/auth/oauth/start", response_model=OAuthStartResponse)
async def oauth_start(
    redirect_uri: str,
    auth: Annotated[AuthService, Depends(get_auth_service)],
) -> OAuthStartResponse:
    state = secrets.token_urlsafe(24)
    url = auth.oauth_authorize_url(state=state, redirect_uri=redirect_uri)
    return OAuthStartResponse(authorize_url=url, state=state)


@router.post("/auth/oauth/callback", response_model=AuthTokenResponse)
async def oauth_callback(
    payload: OAuthCallbackRequest,
    auth: Annotated[AuthService, Depends(get_auth_service)],
) -> AuthTokenResponse:
    return await auth.oauth_complete_login(
        code=payload.code,
        redirect_uri=payload.redirect_uri,
        client_id=payload.client_id,
        client_platform=payload.client_platform,
    )


@router.post("/auth/router-token", response_model=ClientRouterTokenResponse)
async def issue_client_router_token(
    payload: ClientRouterTokenRequest,
    user: Annotated[UserView, Depends(current_user)],
    auth: Annotated[AuthService, Depends(get_auth_service)],
) -> ClientRouterTokenResponse:
    return await auth.issue_client_router_tokens(
        user_id=user.id,
        client_id=payload.client_id,
        platform=payload.platform,
    )


@router.post("/devices/register", response_model=RegisterDeviceResponse)
async def register_device(
    payload: RegisterDeviceRequest,
    user: Annotated[UserView, Depends(current_user)],
    devices: Annotated[DeviceService, Depends(get_device_service)],
) -> RegisterDeviceResponse:
    return await devices.register_device(
        user_id=user.id,
        req=payload,
        actor=f"user:{user.id}",
        entitlements=user.entitlements,
    )


@router.post("/devices/router-token", response_model=DeviceRouterTokenResponse)
async def issue_device_router_token(
    payload: DeviceRouterTokenRequest,
    auth: Annotated[AuthService, Depends(get_auth_service)],
) -> DeviceRouterTokenResponse:
    return await auth.issue_device_router_tokens(
        device_id=payload.device_id,
        device_secret=payload.device_secret,
    )
