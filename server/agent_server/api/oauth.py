from __future__ import annotations

import hashlib
import hmac
import re
import time
from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Form, Header, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from loguru import logger

from agent_server.core.api_namespace import api_v2_path
from agent_server.core.auth import (
    DEFAULT_USER_EXPIRES_IN,
    create_signed_token,
    create_user_access_token,
    verify_signed_token,
)
from agent_server.core.models import (
    OAuthAuthorizeRequest,
    OAuthAuthorizeResponse,
    OAuthMetadataResponse,
    OAuthTokenResponse,
    UserView,
)
from agent_server.core.oauth_clients import (
    FirstPartyOAuthClient,
    first_party_oauth_client,
)
from agent_server.core.utc import utc_now
from agent_server.deps import current_user, current_user_id, get_store
from agent_server.infra.repositories.facade import Store

router = APIRouter(tags=["oauth"])
PROFILE_TOKEN_KIND = "oauth_userinfo"
PROFILE_TOKEN_TTL = 300
PRIVATE_HEADERS = {
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "Referrer-Policy": "no-referrer",
}


def _oauth_client(client_id: str) -> FirstPartyOAuthClient:
    try:
        client = first_party_oauth_client(client_id)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from None
    if client is None:
        raise HTTPException(status_code=404, detail="oauth client not found")
    return client


def _validate_authorization(payload: OAuthAuthorizeRequest) -> FirstPartyOAuthClient:
    if payload.response_type != "code":
        raise HTTPException(status_code=422, detail="response_type must be code")
    client = _oauth_client(payload.client_id)
    if not client.allows_redirect(payload.redirect_uri):
        raise HTTPException(status_code=422, detail="redirect uri is not allowed")
    if payload.code_challenge_method != "S256" or not re.fullmatch(
        r"[A-Za-z0-9_-]{43}", payload.code_challenge
    ):
        raise HTTPException(
            status_code=422, detail="a valid S256 code challenge is required"
        )
    if client.client_secret is not None:
        scopes = set(payload.scope.split())
        if "profile" not in scopes or not scopes <= {"profile", "email"}:
            raise HTTPException(
                status_code=422, detail="scope must be profile or profile email"
            )
        if not payload.state or len(payload.state) > 512:
            raise HTTPException(
                status_code=422,
                detail="state is required and must not exceed 512 characters",
            )
    return client


@router.get(
    "/.well-known/oauth-authorization-server", response_model=OAuthMetadataResponse
)
async def oauth_metadata(request: Request) -> OAuthMetadataResponse:
    issuer = _public_origin(request)
    return OAuthMetadataResponse(
        issuer=issuer,
        authorization_endpoint=f"{issuer}{api_v2_path('/oauth/authorize')}",
        token_endpoint=f"{issuer}{api_v2_path('/oauth/token')}",
        response_types_supported=["code"],
        grant_types_supported=["authorization_code"],
        code_challenge_methods_supported=["S256"],
    )


@router.get("/oauth/authorize")
async def oauth_authorize(
    request: Request,
    response_type: str,
    client_id: str,
    redirect_uri: str,
    code_challenge: str,
    db: Annotated[Store, Depends(get_store)],
    code_challenge_method: str = "S256",
    scope: str = "",
    state: str | None = None,
    authorization: str | None = Header(None),
) -> RedirectResponse:
    payload = OAuthAuthorizeRequest(
        response_type=response_type,
        client_id=client_id,
        redirect_uri=redirect_uri,
        code_challenge=code_challenge,
        code_challenge_method=code_challenge_method,
        scope=scope,
        state=state,
    )
    client = _validate_authorization(payload)
    if client.client_secret is not None:
        # The browser session lives in the existing web app. It authenticates
        # the approval POST with its user token; this GET never issues a code.
        query = urlencode(payload.model_dump(exclude_none=True, exclude={"approved"}))
        return RedirectResponse(
            f"/#/tokens-anywhere-oauth?{query}", headers=PRIVATE_HEADERS
        )
    user = await current_user(await current_user_id(request, authorization), db)
    redirect_url = await _create_authorization_redirect(
        payload=payload, user=user, db=db
    )
    return RedirectResponse(redirect_url, headers=PRIVATE_HEADERS)


@router.post("/oauth/authorize", response_model=OAuthAuthorizeResponse)
async def oauth_authorize_json(
    payload: OAuthAuthorizeRequest,
    response: Response,
    user: Annotated[UserView, Depends(current_user)],
    db: Annotated[Store, Depends(get_store)],
) -> OAuthAuthorizeResponse:
    response.headers.update(PRIVATE_HEADERS)
    redirect_url = await _create_authorization_redirect(
        payload=payload, user=user, db=db
    )
    return OAuthAuthorizeResponse(redirectUrl=redirect_url, serverTime=utc_now())


async def _create_authorization_redirect(
    *, payload: OAuthAuthorizeRequest, user: UserView, db: Store
) -> str:
    client = _validate_authorization(payload)
    params: dict[str, str] = {}
    if payload.approved:
        try:
            params["code"] = await db.create_oauth_authorization_code(
                client_id=client.client_id,
                user_id=user.userId,
                redirect_uri=payload.redirect_uri,
                scope=payload.scope,
                code_challenge=payload.code_challenge,
                code_challenge_method=payload.code_challenge_method,
            )
        except (KeyError, ValueError):
            raise HTTPException(
                status_code=400, detail="invalid authorization request"
            ) from None
    else:
        params["error"] = "access_denied"
    if payload.state is not None:
        params["state"] = payload.state
    logger.info(
        "OAuth authorization client={} user={} approved={}",
        client.client_id,
        user.userId,
        payload.approved,
    )
    return f"{payload.redirect_uri}?{urlencode(params)}"


@router.post("/oauth/token", response_model=OAuthTokenResponse)
async def oauth_token(
    response: Response,
    db: Annotated[Store, Depends(get_store)],
    grant_type: str = Form(...),
    code: str = Form(...),
    client_id: str = Form(...),
    redirect_uri: str = Form(...),
    code_verifier: str = Form(...),
    client_secret: str = Form(""),
) -> OAuthTokenResponse:
    response.headers.update(PRIVATE_HEADERS)
    if grant_type != "authorization_code":
        raise HTTPException(
            status_code=422, detail="grant_type must be authorization_code"
        )
    client = _oauth_client(client_id)
    if client.client_secret is not None:
        if not hmac.compare_digest(
            client.client_secret.encode(), client_secret.encode()
        ):
            logger.info(
                "OAuth token rejected client={} reason=client_authentication",
                client.client_id,
            )
            raise HTTPException(
                status_code=401,
                detail="invalid client credentials",
                headers=PRIVATE_HEADERS,
            )
        if not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", code_verifier):
            raise HTTPException(
                status_code=400, detail="invalid code verifier", headers=PRIVATE_HEADERS
            )
    if not client.allows_redirect(redirect_uri):
        raise HTTPException(
            status_code=400,
            detail="redirect uri is not allowed",
            headers=PRIVATE_HEADERS,
        )
    try:
        user, scope = await db.consume_oauth_authorization_code(
            code=code,
            client_id=client_id,
            redirect_uri=redirect_uri,
            code_verifier=code_verifier,
        )
    except ValueError:
        logger.info(
            "OAuth token rejected client={} reason=invalid_grant", client.client_id
        )
        raise HTTPException(
            status_code=400,
            detail="invalid or expired authorization code",
            headers=PRIVATE_HEADERS,
        ) from None
    if user.disabled:
        raise HTTPException(
            status_code=403, detail="account disabled", headers=PRIVATE_HEADERS
        )
    if client.client_secret is not None:
        token = create_signed_token(
            PROFILE_TOKEN_KIND,
            {
                "user_id": user.userId,
                "client_id": client.client_id,
                "client_key": hashlib.sha256(client.client_secret.encode()).hexdigest(),
                "grant": hashlib.sha256(code.encode()).hexdigest(),
                "scope": scope,
            },
            PROFILE_TOKEN_TTL,
        )
        logger.info(
            "OAuth profile token issued client={} user={}",
            client.client_id,
            user.userId,
        )
        return OAuthTokenResponse(
            access_token=token, expires_in=PROFILE_TOKEN_TTL, scope=scope
        )
    return OAuthTokenResponse(
        access_token=create_user_access_token(user.userId),
        expires_in=DEFAULT_USER_EXPIRES_IN,
        scope=scope,
    )


@router.get("/oauth/userinfo")
async def oauth_userinfo(
    response: Response,
    db: Annotated[Store, Depends(get_store)],
    authorization: str | None = Header(None),
) -> dict[str, str | bool | None]:
    response.headers.update(PRIVATE_HEADERS)
    invalid_token = HTTPException(
        status_code=401,
        detail="invalid or expired profile token",
        headers={
            **PRIVATE_HEADERS,
            "WWW-Authenticate": 'Bearer error="invalid_token"',
        },
    )
    if not authorization or not authorization.startswith("Bearer "):
        raise invalid_token
    try:
        claims = verify_signed_token(PROFILE_TOKEN_KIND, authorization[7:])
    except (ValueError, TypeError, AttributeError):
        raise invalid_token from None
    if (
        not claims
        or claims.get("client_id") != "tokens-anywhere"
        or claims.get("exp", 0) <= time.time()
    ):
        raise invalid_token
    try:
        client = first_party_oauth_client("tokens-anywhere")
    except ValueError:
        raise invalid_token from None
    if (
        client is None
        or not client.client_secret
        or claims.get("client_key")
        != hashlib.sha256(client.client_secret.encode()).hexdigest()
    ):
        raise invalid_token
    scope = set(str(claims.get("scope", "")).split())
    if "profile" not in scope or not scope <= {"profile", "email"}:
        raise invalid_token
    try:
        user = await db.oauth_profile_user(
            str(claims.get("grant", "")), client.client_id, client.redirect_uri
        )
    except KeyError:
        raise invalid_token from None
    if user.userId != claims.get("user_id") or user.disabled:
        raise invalid_token
    return {
        "userid": user.userId,
        "name": user.displayName,
        "email": user.email if "email" in scope else None,
        "email_verified": bool(user.email and user.emailVerified and "email" in scope),
        "avatar": user.avatar,
    }


def _public_origin(request: Request) -> str:
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    scheme = forwarded_proto or request.url.scheme
    host = forwarded_host or request.url.netloc
    return f"{scheme}://{host}"
