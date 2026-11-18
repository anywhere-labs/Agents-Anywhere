from __future__ import annotations

import os
import urllib.parse
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import FileResponse

from agent_server.api.device_session_reads import device_read_http_error
from agent_server.api.device_transfers import get_device_blobs
from agent_server.api.v2_compat import V3_SESSION_ONLY
from agent_server.core.models import (
    PublicSessionShareResponse,
    PublicSharedSession,
    SessionShareCreateRequest,
    SessionShareCreateResponse,
    TimelineItem,
)
from agent_server.core.utc import utc_now
from agent_server.deps import (
    current_user_id,
    get_attachment_service,
    get_store,
)
from agent_server.infra.repositories.facade import Store
from agent_server.services.attachments import AttachmentService
from agent_server.services.device_blobs import DeviceBlobService
from agent_server.services.device_reads import (
    DeviceReadError,
    DeviceReadTimeout,
)

router = APIRouter(tags=["session-shares"])


@router.post(
    "/sessions/{session_id}/shares",
    response_model=SessionShareCreateResponse,
    status_code=201,
    dependencies=V3_SESSION_ONLY,
)
async def create_session_share(
    session_id: str,
    payload: SessionShareCreateRequest,
    request: Request,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    blobs: DeviceBlobService = Depends(get_device_blobs),
) -> SessionShareCreateResponse:
    try:
        owned = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    # The device exports the snapshot (v3); v2 sessions never get here (``V3_SESSION_ONLY``).
    share = await _device_share(db, blobs, owned, payload, user_id=user_id)
    return _share_response(request, share, payload.scope)


def _share_response(request: Request, share: dict[str, Any], scope: str) -> SessionShareCreateResponse:
    share_path = f"/share/{share['id']}"
    return SessionShareCreateResponse(
        shareId=share["id"],
        sharePath=share_path,
        shareUrl=f"{_public_origin(request)}{share_path}",
        scope=scope,
        createdAt=share["createdAt"],
    )


async def _device_share(
    db: Store,
    blobs: DeviceBlobService,
    session: Any,
    payload: SessionShareCreateRequest,
    *,
    user_id: str,
) -> dict[str, Any]:
    """v3: the device exports an immutable snapshot; the Server keeps it and copies of its files."""

    try:
        exported = await blobs.export_share(
            session.connectorId,
            session.id,
            scope=payload.scope,
            item_ids=list(payload.itemIds) if payload.scope == "message" else [],
        )
    except DeviceReadError as exc:
        if exc.code == "share_too_large":
            raise HTTPException(status_code=413, detail={"code": exc.code, "message": exc.message}) from exc
        raise device_read_http_error(exc) from exc
    except DeviceReadTimeout as exc:
        raise device_read_http_error(exc) from exc
    if exported is None:
        raise HTTPException(
            status_code=409,
            detail={"code": "share_requires_online_device", "message": "the device must be online to create a share"},
        )
    try:
        selected = [TimelineItem.model_validate(item) for item in exported["items"]]
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail={"code": "device_response_invalid", "message": str(exc)[:500]}
        ) from exc
    if payload.scope == "message":
        if {item.id for item in selected} != set(payload.itemIds):
            raise HTTPException(status_code=404, detail="timeline item not found")
        if any(item.type != "message" or item.role != "assistant" for item in selected):
            raise HTTPException(status_code=422, detail="a reply share may only contain assistant messages")
    if not selected:
        raise HTTPException(status_code=422, detail="there is no content to share")
    items = [item.model_dump(mode="json", exclude_none=True) for item in selected]
    referenced = _attachment_file_ids(items) | set(exported["attachments"])
    missing = await blobs.copy_for_share(session.connectorId, session.id, sorted(referenced))
    snapshot = {
        "session": {
            "id": session.id,
            "title": session.title,
            "runtime": session.runtime,
            "runtimeName": session.runtimeName,
            "cwd": session.cwd,
        },
        "items": items,
    }
    return await db.create_session_share(
        user_id=user_id,
        session_id=session.id,
        scope=payload.scope,
        snapshot=snapshot,
        allowed_file_ids=referenced - set(missing),
    )


@router.get(
    "/public/shares/{share_id}",
    response_model=PublicSessionShareResponse,
)
async def public_session_share(
    share_id: str,
    db: Store = Depends(get_store),
) -> PublicSessionShareResponse:
    share = await _share_or_404(db, share_id)
    snapshot = share["snapshot"]
    try:
        session = PublicSharedSession.model_validate(snapshot["session"])
        items = [TimelineItem.model_validate(item) for item in snapshot["items"]]
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=500, detail="invalid share snapshot") from exc
    return PublicSessionShareResponse(
        shareId=share["id"],
        scope=share["scope"],
        session=session,
        items=items,
        createdAt=share["createdAt"],
        serverTime=utc_now(),
    )


@router.get("/public/shares/{share_id}/attachments/{file_id}")
async def public_share_attachment(
    share_id: str,
    file_id: str,
    request: Request,
    db: Store = Depends(get_store),
    attachments: AttachmentService = Depends(get_attachment_service),
) -> Response:
    share = await _share_or_404(db, share_id)
    if file_id not in set(share["allowedFileIds"]):
        raise HTTPException(status_code=404, detail="file not found")
    try:
        path, metadata = await attachments.local_signed_file(
            session_id=share["sessionId"],
            file_id=file_id,
        )
        if path is not None:
            await attachments.verify_local_file(path, metadata)
            return _shared_file_response(request, path, metadata)
        data, metadata = await attachments.read_shared_file(
            session_id=share["sessionId"],
            file_id=file_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="file not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    name = str(metadata.get("name") or file_id)
    return Response(
        content=data,
        media_type=str(metadata.get("mediaType") or "application/octet-stream"),
        headers={
            "Content-Disposition": _content_disposition(name),
            "Cache-Control": "private, max-age=300",
        },
    )


CACHE_CONTROL_SHARED = "private, max-age=3600"


def _shared_file_response(
    request: Request, path: Path, metadata: dict[str, Any]
) -> Response:
    """Stream a shared attachment from disk with range support."""
    name = str(metadata.get("name") or path.name)
    sha256 = str(metadata.get("sha256") or "")
    if sha256:
        etag = f'"{sha256}"'
        if_none_match = request.headers.get("if-none-match")
        if if_none_match and (
            "*" in {tag.strip() for tag in if_none_match.split(",")}
            or etag in {tag.strip() for tag in if_none_match.split(",")}
        ):
            return Response(
                status_code=304,
                headers={"ETag": etag, "Cache-Control": CACHE_CONTROL_SHARED},
            )
    headers = {
        "Content-Disposition": _content_disposition(name),
        "Cache-Control": CACHE_CONTROL_SHARED,
    }
    if sha256:
        headers["ETag"] = f'"{sha256}"'
    return FileResponse(
        path,
        media_type=str(metadata.get("mediaType") or "application/octet-stream"),
        headers=headers,
    )


async def _share_or_404(db: Store, share_id: str) -> dict[str, Any]:
    try:
        return await db.get_session_share(share_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="share not found") from None


def _attachment_file_ids(value: Any) -> set[str]:
    found: set[str] = set()

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            file_id = node.get("fileId")
            if isinstance(file_id, str) and file_id.startswith("file_"):
                found.add(file_id)
            for nested in node.values():
                visit(nested)
        elif isinstance(node, list):
            for nested in node:
                visit(nested)

    visit(value)
    return found


def _public_origin(request: Request) -> str:
    configured = os.environ.get("AGENT_SERVER_PUBLIC_ORIGIN", "").strip().rstrip("/")
    if configured:
        return configured
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    scheme = forwarded_proto or request.url.scheme
    host = forwarded_host or request.url.netloc
    return f"{scheme}://{host}"


def _content_disposition(name: str) -> str:
    fallback = "".join(
        character
        if 32 <= ord(character) < 127 and character not in {'"', "\\"}
        else "_"
        for character in name
    )
    encoded = urllib.parse.quote(name, safe="")
    ascii_name = fallback or "attachment"
    return f'inline; filename="{ascii_name}"; filename*=UTF-8\'\'{encoded}'
