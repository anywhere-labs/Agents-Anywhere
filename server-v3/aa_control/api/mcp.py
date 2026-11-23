from __future__ import annotations

from typing import Annotated, Any
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Form, Header, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field

from aa_control.api.deps import (
    bearer_token,
    current_user,
    get_auth_service,
    get_mcp_service,
    public_origin,
)
from aa_control.core.errors import UnauthenticatedError, ValidationError
from aa_control.core.models import OkResponse, UserView
from aa_control.services.auth_service import AuthService
from aa_control.services.mcp_service import McpService

router = APIRouter(tags=["mcp"])


class McpDynamicClientRegisterRequest(BaseModel):
    client_name: str = Field(min_length=1, max_length=128)
    redirect_uris: list[str] = Field(min_length=1)


class McpAuthorizeApproveRequest(BaseModel):
    client_id: str
    redirect_uri: str
    code_challenge: str
    code_challenge_method: str = "S256"
    state: str | None = None
    scopes: list[str]
    device_ids: list[str] = Field(default_factory=list)


@router.get("/.well-known/oauth-protected-resource")
async def oauth_protected_resource(
    request: Request,
    mcp: Annotated[McpService, Depends(get_mcp_service)],
) -> dict[str, Any]:
    return mcp.protected_resource_metadata(public_origin(request))


@router.get("/.well-known/oauth-authorization-server")
async def oauth_authorization_server(
    request: Request,
    mcp: Annotated[McpService, Depends(get_mcp_service)],
) -> dict[str, Any]:
    return mcp.oauth_metadata(public_origin(request))


@router.post("/oauth/register", status_code=201)
async def oauth_register_client(
    payload: McpDynamicClientRegisterRequest,
    mcp: Annotated[McpService, Depends(get_mcp_service)],
) -> dict[str, Any]:
    return await mcp.register_client(
        client_name=payload.client_name,
        redirect_uris=payload.redirect_uris,
    )


@router.get("/oauth/authorize", response_model=None)
async def oauth_authorize_preview(
    request: Request,
    auth: Annotated[AuthService, Depends(get_auth_service)],
    mcp: Annotated[McpService, Depends(get_mcp_service)],
    client_id: str | None = None,
    redirect_uri: str | None = None,
    scope: str = "",
    authorization: str | None = Header(default=None),
) -> dict[str, Any] | RedirectResponse:
    # A browser navigation (an MCP client opening the authorization endpoint) never carries a Bearer
    # header: hand it to the Web consent page with the untouched query. Bearer callers get JSON.
    if not authorization:
        consent_url = mcp.consent_page_redirect(request.url.query)
        if consent_url is not None:
            return RedirectResponse(consent_url, status_code=302, headers={"Cache-Control": "no-store"})
    user = await auth.authenticate_access_token(bearer_token(authorization))
    if not client_id or not redirect_uri:
        raise ValidationError("client_id and redirect_uri are required")
    requested = [s for s in scope.split() if s]
    return await mcp.consent_preview(
        user_id=user.id,
        client_id=client_id,
        redirect_uri=redirect_uri,
        requested_scopes=requested,
    )


@router.post("/oauth/authorize")
async def oauth_authorize_approve(
    payload: McpAuthorizeApproveRequest,
    user: Annotated[UserView, Depends(current_user)],
    mcp: Annotated[McpService, Depends(get_mcp_service)],
) -> dict[str, Any]:
    code = await mcp.approve_authorization(
        user_id=user.id,
        client_id=payload.client_id,
        redirect_uri=payload.redirect_uri,
        code_challenge=payload.code_challenge,
        code_challenge_method=payload.code_challenge_method,
        approved_scopes=payload.scopes,
        device_ids=payload.device_ids,
    )
    query: dict[str, str] = {"code": code}
    if payload.state:
        query["state"] = payload.state
    sep = "&" if "?" in payload.redirect_uri else "?"
    return {
        "code": code,
        "redirect_url": f"{payload.redirect_uri}{sep}{urlencode(query)}",
    }


@router.post("/oauth/token")
async def oauth_token(
    mcp: Annotated[McpService, Depends(get_mcp_service)],
    grant_type: str = Form(...),
    client_id: str = Form(...),
    code: str = Form(...),
    redirect_uri: str = Form(...),
    code_verifier: str = Form(...),
) -> JSONResponse:
    if grant_type != "authorization_code":
        return JSONResponse(status_code=400, content={"error": "unsupported_grant_type"})
    result = await mcp.exchange_code(
        client_id=client_id,
        code=code,
        redirect_uri=redirect_uri,
        code_verifier=code_verifier,
    )
    return JSONResponse(
        content=result,
        headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
    )


@router.get("/mcp/grants")
async def list_mcp_grants(
    user: Annotated[UserView, Depends(current_user)],
    mcp: Annotated[McpService, Depends(get_mcp_service)],
) -> dict[str, Any]:
    return {"grants": await mcp.list_grants(user.id)}


@router.delete("/mcp/grants/{grant_id}", response_model=OkResponse)
async def revoke_mcp_grant(
    grant_id: str,
    user: Annotated[UserView, Depends(current_user)],
    mcp: Annotated[McpService, Depends(get_mcp_service)],
) -> OkResponse:
    revoked = await mcp.revoke_grant(user_id=user.id, grant_id=grant_id)
    return OkResponse(ok=revoked)


@router.post("/mcp")
async def mcp_streamable_http(
    request: Request,
    mcp: Annotated[McpService, Depends(get_mcp_service)],
    authorization: str | None = Header(default=None),
) -> Response:
    resource_meta = f"{public_origin(request)}/.well-known/oauth-protected-resource"
    if not authorization or not authorization.lower().startswith("bearer "):
        return JSONResponse(
            status_code=401,
            content={"error": "unauthorized", "detail": "MCP Bearer token is required"},
            headers={"WWW-Authenticate": f'Bearer resource_metadata="{resource_meta}"'},
        )
    raw_token = authorization[7:].strip()
    try:
        grant = await mcp.authenticate_token(raw_token)
    except UnauthenticatedError as exc:
        return JSONResponse(
            status_code=401,
            content={"error": "invalid_token", "detail": exc.message},
            headers={"WWW-Authenticate": f'Bearer resource_metadata="{resource_meta}"'},
        )

    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse(
            status_code=400,
            content={"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}},
        )
    reply = await mcp.handle_jsonrpc(grant=grant, request=body)
    if reply is None:
        return Response(status_code=202)
    return JSONResponse(content=reply)
