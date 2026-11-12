from __future__ import annotations

import os
from typing import Annotated, Any
from urllib.parse import urlencode

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    Response,
)
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field

from agent_server.core.api_namespace import api_v2_path
from agent_server.core.model_config import ModelPreferences
from agent_server.core.models import UserView
from agent_server.deps import current_user_id, get_tokens_link_service, require_admin
from agent_server.infra.tokens_client import TokensError
from agent_server.services.device_runtimes import DeviceRuntimeError
from agent_server.services.model_config import ModelConfigError
from agent_server.services.tokens_link import TokensLinkError, TokensLinkService

router = APIRouter(tags=["tokens-anywhere"])

CALLBACK_PATH = "/integrations/tokens/callback"
SETTINGS_ROUTE = "#/settings/model-configs"
BROWSER_COOKIE_MAX_AGE = 600

Service = Annotated[TokensLinkService, Depends(get_tokens_link_service)]
UserId = Annotated[str, Depends(current_user_id)]


class RotateKeyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allowInterrupt: bool = False


class EmbedTicketRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # The console page to open; the user returns there when an embed session expires.
    next: str = Field(default="/console/", max_length=512)


class TokensSettingsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Empty or null turns Tokens Anywhere off on this instance.
    tokensUrl: str | None = Field(default=None, max_length=2048)


def _public_origin(request: Request) -> str:
    configured = os.environ.get("AGENT_SERVER_PUBLIC_ORIGIN", "").strip().rstrip("/")
    if configured:
        return configured
    scheme = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.url.netloc
    return f"{scheme}://{host}"


def _browser_cookie(request: Request) -> str:
    # Secure ``__Host-`` cookies need HTTPS; a LAN instance over http gets a plain one.
    return "__Host-aa_tokens_link" if _public_origin(request).startswith("https://") else "aa_tokens_link"


def _settings_redirect(request: Request, error: str, *, clear_cookie: bool) -> RedirectResponse:
    query = urlencode({"tokensLink": error})
    response = RedirectResponse(f"{_public_origin(request)}/?{query}{SETTINGS_ROUTE}", status_code=302)
    if clear_cookie:
        response.delete_cookie(_browser_cookie(request), path="/")
    return response


def _raise(exc: TokensLinkError | ModelConfigError | DeviceRuntimeError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


@router.get("/integrations/tokens")
async def get_tokens_link(service: Service, user_id: UserId) -> dict[str, Any]:
    return await service.status(user_id=user_id)


@router.post("/integrations/tokens/link")
async def begin_tokens_link(request: Request, service: Service, user_id: UserId) -> dict[str, Any]:
    """A one-time address to open in the browser that will authorize the link."""
    origin = _public_origin(request)
    try:
        ticket = await service.begin_link(
            user_id=user_id, redirect_uri=f"{origin}{api_v2_path(CALLBACK_PATH)}"
        )
    except TokensLinkError as exc:
        _raise(exc)
    start = f"{origin}{api_v2_path('/integrations/tokens/start')}?{urlencode({'ticket': ticket})}"
    return {"startUrl": start}


@router.get("/integrations/tokens/start")
async def start_tokens_link(request: Request, service: Service, ticket: str = "") -> RedirectResponse:
    try:
        url, browser = await service.open_ticket(ticket)
    except TokensLinkError as exc:
        # A stale start link must not end a link this browser has in progress.
        return _settings_redirect(request, exc.code, clear_cookie=False)
    response = RedirectResponse(url, status_code=302)
    response.set_cookie(
        _browser_cookie(request),
        browser,
        max_age=BROWSER_COOKIE_MAX_AGE,
        path="/",
        httponly=True,
        secure=_public_origin(request).startswith("https://"),
        samesite="lax",
    )
    return response


@router.get("/integrations/tokens/account")
async def get_tokens_account(service: Service, user_id: UserId) -> dict[str, Any]:
    try:
        return await service.account(user_id=user_id)
    except TokensLinkError as exc:
        _raise(exc)


@router.get("/integrations/tokens/usage")
async def get_tokens_usage(
    service: Service,
    user_id: UserId,
    days: Annotated[int, Query(ge=1, le=92)] = 30,
) -> dict[str, Any]:
    try:
        return await service.usage(user_id=user_id, days=days)
    except TokensLinkError as exc:
        _raise(exc)


@router.post("/integrations/tokens/embed-ticket")
async def create_tokens_embed_ticket(
    payload: EmbedTicketRequest, response: Response, service: Service, user_id: UserId
) -> dict[str, Any]:
    """A single-use address that opens the linked account's console in an iframe."""
    response.headers["Cache-Control"] = "no-store"
    try:
        return await service.embed_ticket(user_id=user_id, next_path=payload.next)
    except TokensLinkError as exc:
        _raise(exc)


@router.put("/integrations/tokens/models")
async def put_tokens_models(payload: ModelPreferences, service: Service, user_id: UserId) -> dict[str, Any]:
    """Choose and rename the Tokens models; runtimes on Anywhere are rewritten through the switch."""
    try:
        applying = await service.save_model_preferences(payload, user_id=user_id)
    except (TokensLinkError, ModelConfigError) as exc:
        _raise(exc)
    return {"applying": applying}


@router.get("/integrations/tokens/callback")
async def tokens_link_callback(
    request: Request,
    service: Service,
    state: str | None = None,
    code: str | None = None,
    iss: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    try:
        issuer = await service.complete(
            state=state,
            code=code,
            issuer=iss,
            error=error,
            browser=request.cookies.get(_browser_cookie(request)),
        )
    except TokensLinkError as exc:
        return _settings_redirect(request, exc.code, clear_cookie=True)
    # The rest of the flow stays on Tokens Anywhere; clients learn the result from the snapshot.
    response = RedirectResponse(f"{issuer}/oauth/done/", status_code=302)
    response.delete_cookie(_browser_cookie(request), path="/")
    return response


@router.post("/integrations/tokens/sync")
async def sync_tokens_catalog(service: Service, user_id: UserId) -> dict[str, Any]:
    try:
        return await service.sync(user_id=user_id)
    except (TokensLinkError, ModelConfigError) as exc:
        _raise(exc)
    except TokensError as exc:
        raise HTTPException(
            status_code=502, detail={"code": exc.code, "message": "Tokens Anywhere is unavailable"}
        ) from exc


@router.delete("/integrations/tokens/link")
async def unlink_tokens(service: Service, user_id: UserId) -> dict[str, Any]:
    try:
        return await service.unlink(user_id=user_id)
    except (TokensLinkError, ModelConfigError) as exc:
        _raise(exc)


@router.post("/model-profiles/{profile_id}/rotate-key")
async def rotate_tokens_key(
    profile_id: str,
    payload: RotateKeyRequest,
    service: Service,
    user_id: UserId,
) -> dict[str, Any]:
    """Rotate the managed key; returns the channel state the rewrite shows up in."""
    try:
        return await service.rotate_key(profile_id, user_id=user_id, allow_interrupt=payload.allowInterrupt)
    except (TokensLinkError, ModelConfigError, DeviceRuntimeError) as exc:
        _raise(exc)
    except TokensError as exc:
        raise HTTPException(
            status_code=502, detail={"code": exc.code, "message": "Tokens Anywhere is unavailable"}
        ) from exc


@router.get("/admin/integrations/tokens")
async def get_tokens_settings(
    service: Service, _admin: Annotated[UserView, Depends(require_admin)]
) -> dict[str, Any]:
    return await service.admin_settings()


@router.put("/admin/integrations/tokens")
async def put_tokens_settings(
    payload: TokensSettingsRequest,
    service: Service,
    _admin: Annotated[UserView, Depends(require_admin)],
) -> dict[str, Any]:
    try:
        return await service.set_tokens_url(payload.tokensUrl)
    except TokensLinkError as exc:
        _raise(exc)
