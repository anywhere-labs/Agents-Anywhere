from __future__ import annotations

import os
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse

from agent_server.core.api_namespace import api_v2_path
from agent_server.core.auth import DEFAULT_USER_EXPIRES_IN, create_user_access_token
from agent_server.core.models import (
    OAuthAuthorizeRequest,
    OAuthAuthorizeResponse,
    OAuthDeviceApprovalResponse,
    OAuthDeviceApproveRequest,
    OAuthDeviceCodeResponse,
    OAuthDeviceLookupRequest,
    OAuthMetadataResponse,
    OAuthTokenResponse,
    UserView,
)
from agent_server.core.oauth_clients import first_party_oauth_client
from agent_server.core.oauth_device import (
    DEVICE_APPROVAL_CONFLICT,
    DEVICE_CODE_TTL_SECONDS,
    DEVICE_ERRORS,
    DEVICE_GRANT_TYPE,
    OAuthDeviceFlowError,
)
from agent_server.core.utc import utc_now
from agent_server.deps import current_user, get_store
from agent_server.infra.repositories.facade import Store

router = APIRouter(tags=["oauth"])


@router.get("/.well-known/oauth-authorization-server", response_model=OAuthMetadataResponse)
async def oauth_metadata(request: Request) -> OAuthMetadataResponse:
    issuer = _public_origin(request)
    return OAuthMetadataResponse(
        issuer=issuer,
        authorization_endpoint=f"{issuer}{api_v2_path('/oauth/authorize')}",
        token_endpoint=f"{issuer}{api_v2_path('/oauth/token')}",
        device_authorization_endpoint=f"{issuer}{api_v2_path('/oauth/device/code')}",
        response_types_supported=["code"],
        grant_types_supported=["authorization_code", DEVICE_GRANT_TYPE],
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
    client = first_party_oauth_client(client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="oauth client not found")
    if not client.allows_redirect(redirect_uri):
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
    client = first_party_oauth_client(client_id)
    if client is None:
        raise HTTPException(status_code=404, detail="oauth client not found")
    if not client.allows_redirect(redirect_uri):
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


@router.post("/oauth/device/code", response_model=OAuthDeviceCodeResponse)
async def oauth_device_code(
    request: Request,
    client_id: str = Form(...),
    scope: str = Form(""),
    db: Store = Depends(get_store),
) -> OAuthDeviceCodeResponse:
    """Start a device authorization request (RFC 8628 section 3.1).

    The grant is scoped to the OpenCode plug-in client; the repository raises
    ``KeyError`` for every other client id, first-party or not, so they get the
    same 404 an unknown client gets.
    """

    try:
        device_code, user_code, interval = await db.create_oauth_device_code(
            client_id=client_id,
            scope=scope,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="oauth client not found") from None
    verification_uri = f"{_public_origin(request)}/#/plugin-device"
    return OAuthDeviceCodeResponse(
        device_code=device_code,
        user_code=user_code,
        verification_uri=verification_uri,
        verification_uri_complete=f"{verification_uri}?user_code={user_code}",
        expires_in=DEVICE_CODE_TTL_SECONDS,
        interval=interval,
    )


@router.post("/oauth/device/token")
async def oauth_device_token(
    grant_type: str = Form(...),
    device_code: str = Form(...),
    client_id: str = Form(...),
    db: Store = Depends(get_store),
):
    """Poll one device authorization request (RFC 8628 section 3.4).

    Errors are RFC 8628 shaped (a top-level ``error`` code) rather than the
    plain detail string the authorization-code endpoint returns, because the
    plug-in has to distinguish ``authorization_pending`` from a failure.
    """

    if grant_type != DEVICE_GRANT_TYPE:
        return _device_error_response(
            "unsupported_grant_type",
            "grant_type must be the device code grant",
        )
    result = await db.poll_oauth_device_code(
        device_code=device_code,
        client_id=client_id,
    )
    status = str(result["status"])
    if status == "approved" and result["user"] is not None:
        user: UserView = result["user"]
        return OAuthTokenResponse(
            access_token=create_user_access_token(user.userId),
            expires_in=DEFAULT_USER_EXPIRES_IN,
            scope=str(result["scope"] or ""),
        )
    if status not in DEVICE_ERRORS:
        status = "invalid_grant"
    return _device_error_response(status, DEVICE_ERRORS[status])


@router.post("/oauth/device/lookup", response_model=OAuthDeviceApprovalResponse)
async def oauth_device_lookup(
    payload: OAuthDeviceLookupRequest,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> OAuthDeviceApprovalResponse:
    """Resolve a typed user code so the web page can show what it approves."""

    try:
        row = await db.lookup_oauth_device_code(
            user_code=payload.userCode,
            user_id=user.userId,
        )
    except OAuthDeviceFlowError as exc:
        raise _device_http_exception(exc) from exc
    if row is None:
        raise HTTPException(status_code=404, detail="user code is invalid or expired")
    return OAuthDeviceApprovalResponse(**row)


@router.post("/oauth/device/approve", response_model=OAuthDeviceApprovalResponse)
async def oauth_device_approve(
    payload: OAuthDeviceApproveRequest,
    user: UserView = Depends(current_user),
    db: Store = Depends(get_store),
) -> OAuthDeviceApprovalResponse:
    """Approve or deny a device request from an authenticated web session."""

    try:
        row = await db.approve_oauth_device_code(
            user_code=payload.userCode,
            user_id=user.userId,
            approved=payload.approved,
        )
    except OAuthDeviceFlowError as exc:
        raise _device_http_exception(exc) from exc
    return OAuthDeviceApprovalResponse(**row)


def _device_error_response(code: str, description: str) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={"error": code, "error_description": description},
    )


def _device_http_exception(exc: OAuthDeviceFlowError) -> HTTPException:
    if exc.code == "too_many_requests":
        status_code = 429
    elif exc.code == DEVICE_APPROVAL_CONFLICT:
        status_code = 409
    else:
        status_code = 404
    return HTTPException(status_code=status_code, detail=exc.description)


def _public_origin(request: Request) -> str:
    # ``X-Forwarded-Host``/``-Proto`` arrive from whoever reaches the reverse
    # proxy, so a forged pair would move the device-code verification link onto
    # an attacker origin.  ``AGENT_SERVER_PUBLIC_ORIGIN`` pins the public origin
    # when it is set (docker/README.md, server/README.md); the forwarded headers
    # are only the fallback for a proxy-less local deployment.
    configured = os.environ.get("AGENT_SERVER_PUBLIC_ORIGIN", "").strip().rstrip("/")
    if configured:
        return configured
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    scheme = forwarded_proto or request.url.scheme
    host = forwarded_host or request.url.netloc
    return f"{scheme}://{host}"
