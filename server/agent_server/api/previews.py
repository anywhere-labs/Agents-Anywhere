"""Port preview API (``contracts/preview/1.0``) and the internal endpoints frps and preview-auth call.

``/api/v3/internal/preview/*`` is not for browsers: the gateway does not route it, and
each call carries ``AGENT_SERVER_PREVIEW_INTERNAL_TOKEN`` in the ``Authorization`` header,
never in the URL (access logs record the path): preview-auth as a bearer token, frps as the
password of HTTP basic auth (its plugin has no header setting, so ``frps.toml`` puts the token in
the userinfo of the plugin ``addr``, which Go's HTTP client sends as ``Authorization: Basic``).
"""

from __future__ import annotations

import base64
import binascii
import hmac
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from starlette.requests import HTTPConnection

from agent_server.core.preview import (
    CreatePreviewRequest,
    PreviewListResponse,
    PreviewTicketResponse,
    PreviewView,
)
from agent_server.core.preview_access import internal_token
from agent_server.deps import current_user_id
from agent_server.services.previews import PreviewError, PreviewService

router = APIRouter(prefix="/api/v3/previews", tags=["previews"])
internal_router = APIRouter(prefix="/api/v3/internal/preview", tags=["previews"], include_in_schema=False)


def get_preview_service(conn: HTTPConnection) -> PreviewService:
    return conn.app.state.previews


def _http(exc: PreviewError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail={"code": exc.code, "message": exc.message, **exc.details})


@router.post("", response_model=PreviewView)
async def create_preview(
    payload: CreatePreviewRequest,
    user_id: str = Depends(current_user_id),
    previews: PreviewService = Depends(get_preview_service),
) -> PreviewView:
    try:
        return await previews.create(user_id, payload)
    except PreviewError as exc:
        raise _http(exc) from exc


@router.get("", response_model=PreviewListResponse)
async def list_previews(
    user_id: str = Depends(current_user_id),
    previews: PreviewService = Depends(get_preview_service),
) -> PreviewListResponse:
    return PreviewListResponse(previews=await previews.list_for_user(user_id))


@router.delete("/{preview_id}", response_model=PreviewView)
async def close_preview(
    preview_id: str,
    user_id: str = Depends(current_user_id),
    previews: PreviewService = Depends(get_preview_service),
) -> PreviewView:
    try:
        return await previews.close(user_id, preview_id)
    except PreviewError as exc:
        raise _http(exc) from exc


@router.post("/{preview_id}/ticket", response_model=PreviewTicketResponse)
async def preview_ticket(
    preview_id: str,
    user_id: str = Depends(current_user_id),
    previews: PreviewService = Depends(get_preview_service),
) -> PreviewTicketResponse:
    try:
        return await previews.ticket(user_id, preview_id)
    except PreviewError as exc:
        raise _http(exc) from exc


def _token_matches(presented: str | None) -> bool:
    expected = internal_token()
    return expected is not None and presented is not None and hmac.compare_digest(presented.encode(), expected.encode())


def _presented_token(authorization: str | None) -> str | None:
    """The internal token of ``Authorization: Bearer <token>`` or ``Basic <user:token>``."""

    if not authorization:
        return None
    scheme, _, value = authorization.strip().partition(" ")
    value = value.strip()
    if scheme.lower() == "bearer":
        return value or None
    if scheme.lower() == "basic":
        try:
            decoded = base64.b64decode(value, validate=True).decode()
        except (binascii.Error, UnicodeDecodeError):
            return None
        _user, sep, password = decoded.partition(":")
        return password if sep and password else None
    return None


@internal_router.post("/frps")
async def frps_plugin(
    op: str = Query(""),
    body: dict[str, Any] = Body(default_factory=dict),
    authorization: str | None = Header(None, alias="Authorization"),
    previews: PreviewService = Depends(get_preview_service),
) -> dict[str, Any]:
    """frps ``httpPlugins`` callback (``Login``, ``NewProxy``, ``CloseProxy``)."""

    if not _token_matches(_presented_token(authorization)):
        raise HTTPException(status_code=404, detail="not found")
    content = body.get("content") if isinstance(body.get("content"), dict) else {}
    return await previews.frps_plugin(op or str(body.get("op") or ""), content)


class RedeemRequest(BaseModel):
    ticket: str = Field(min_length=1)
    slug: str = Field(min_length=1)


@internal_router.post("/redeem")
async def redeem_ticket(
    payload: RedeemRequest,
    authorization: str | None = Header(None, alias="Authorization"),
    previews: PreviewService = Depends(get_preview_service),
) -> dict[str, Any]:
    """preview-auth exchanges a one-time ticket for the preview cookie."""

    if not _token_matches(_presented_token(authorization)):
        raise HTTPException(status_code=401, detail="invalid internal token")
    try:
        return await previews.redeem(payload.ticket, payload.slug)
    except PreviewError as exc:
        raise _http(exc) from exc
