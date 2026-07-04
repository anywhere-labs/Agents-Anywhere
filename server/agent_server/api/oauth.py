from __future__ import annotations

from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import RedirectResponse

from agent_server.core.auth import DEFAULT_USER_EXPIRES_IN, create_user_access_token
from agent_server.core.models import (
    OAuthAuthorizeRequest,
    OAuthAuthorizeResponse,
    OAuthMetadataResponse,
    OAuthTokenResponse,
    UserView,
)
from agent_server.core.utc import utc_now
from agent_server.deps import current_user, get_store
from agent_server.infra.repositories.facade import Store


router = APIRouter(tags=["oauth"])
FIRST_PARTY_CLIENT_ID = "agents-anywhere-mobile"
FIRST_PARTY_REDIRECT_URI = "agents-anywhere://oauth/callback"


@router.get("/.well-known/oauth-authorization-server", response_model=OAuthMetadataResponse)
async def oauth_metadata(request: Request) -> OAuthMetadataResponse:
    issuer = _public_origin(request)
    return OAuthMetadataResponse(
        issuer=issuer,
        authorization_endpoint=f"{issuer}/oauth/authorize",
        token_endpoint=f"{issuer}/oauth/token",
        response_types_supported=["code"],
        grant_types_supported=["authorization_code"],
        code_challenge_methods_supported=["S256"],
    )


@router.get("/oauth/authorize")
async def oauth_authorize(
    response_type: str,
    client_id: str,
    redirect_uri: str,
    code_challenge: str,
    code_challenge_method: str = "S256",
    scope: str = "",
    state: str | None = None,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> RedirectResponse:
    redirect_url = await _create_authorization_redirect(
        response_type=response_type,
        client_id=client_id,
        redirect_uri=redirect_uri,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
        scope=scope,
        state=state,
        user=user,
        db=db,
    )
    return RedirectResponse(redirect_url)


@router.post("/oauth/authorize", response_model=OAuthAuthorizeResponse)
async def oauth_authorize_json(
    payload: OAuthAuthorizeRequest,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> OAuthAuthorizeResponse:
    redirect_url = await _create_authorization_redirect(
        response_type=payload.response_type,
        client_id=payload.client_id,
        redirect_uri=payload.redirect_uri,
        code_challenge=payload.code_challenge,
        code_challenge_method=payload.code_challenge_method,
        scope=payload.scope,
        state=payload.state,
        user=user,
        db=db,
    )
    return OAuthAuthorizeResponse(redirectUrl=redirect_url, serverTime=utc_now())


async def _create_authorization_redirect(
    *,
    response_type: str,
    client_id: str,
    redirect_uri: str,
    code_challenge: str,
    code_challenge_method: str,
    scope: str,
    state: str | None,
    user: UserView,
    db: Store,
) -> str:
    if response_type != "code":
        raise HTTPException(status_code=422, detail="response_type must be code")
    if client_id != FIRST_PARTY_CLIENT_ID:
        raise HTTPException(status_code=404, detail="oauth client not found")
    if redirect_uri != FIRST_PARTY_REDIRECT_URI:
        raise HTTPException(status_code=422, detail="redirect uri is not allowed")
    try:
        code = await db.create_oauth_authorization_code(
            client_id=client_id,
            user_id=user.userId,
            redirect_uri=redirect_uri,
            scope=scope,
            code_challenge=code_challenge,
            code_challenge_method=code_challenge_method,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="oauth client not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    params = {"code": code}
    if state is not None:
        params["state"] = state
    return f"{redirect_uri}?{urlencode(params)}"


@router.post("/oauth/token", response_model=OAuthTokenResponse)
async def oauth_token(
    grant_type: str = Form(...),
    code: str = Form(...),
    client_id: str = Form(...),
    redirect_uri: str = Form(...),
    code_verifier: str = Form(...),
    db: Store = Depends(get_store),
) -> OAuthTokenResponse:
    if grant_type != "authorization_code":
        raise HTTPException(status_code=422, detail="grant_type must be authorization_code")
    if client_id != FIRST_PARTY_CLIENT_ID:
        raise HTTPException(status_code=404, detail="oauth client not found")
    if redirect_uri != FIRST_PARTY_REDIRECT_URI:
        raise HTTPException(status_code=422, detail="redirect uri is not allowed")
    try:
        user, scope = await db.consume_oauth_authorization_code(
            code=code,
            client_id=client_id,
            redirect_uri=redirect_uri,
            code_verifier=code_verifier,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return OAuthTokenResponse(
        access_token=create_user_access_token(user.userId),
        expires_in=DEFAULT_USER_EXPIRES_IN,
        scope=scope,
    )


def _public_origin(request: Request) -> str:
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    scheme = forwarded_proto or request.url.scheme
    host = forwarded_host or request.url.netloc
    return f"{scheme}://{host}"
