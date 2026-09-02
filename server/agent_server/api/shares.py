from __future__ import annotations

import os
import urllib.parse
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response

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
    get_timeline_write_buffer,
)
from agent_server.infra.repositories.facade import Store
from agent_server.services.attachments import AttachmentService
from agent_server.services.timeline_write_buffer import TimelineWriteBuffer

router = APIRouter(tags=["session-shares"])


@router.post(
    "/sessions/{session_id}/shares",
    response_model=SessionShareCreateResponse,
    status_code=201,
)
async def create_session_share(
    session_id: str,
    payload: SessionShareCreateRequest,
    request: Request,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    timeline_write_buffer: TimelineWriteBuffer = Depends(get_timeline_write_buffer),
) -> SessionShareCreateResponse:
    try:
        await db.get_session(session_id, user_id=user_id)
        async with timeline_write_buffer.session_fence(session_id):
            session = await db.get_session(session_id, user_id=user_id)
            timeline = await db.timeline.read(session_id)
            if payload.scope == "message":
                requested_ids = set(payload.itemIds)
                items_by_id = {item.id: item for item in timeline}
                if not requested_ids.issubset(items_by_id):
                    raise HTTPException(
                        status_code=404,
                        detail="timeline item not found",
                    )
                selected = [item for item in timeline if item.id in requested_ids]
                if any(
                    item.type != "message" or item.role != "assistant"
                    for item in selected
                ):
                    raise HTTPException(
                        status_code=422,
                        detail="a reply share may only contain assistant messages",
                    )
            else:
                selected = timeline

            if not selected:
                raise HTTPException(
                    status_code=422,
                    detail="there is no content to share",
                )

            snapshot = {
                "session": {
                    "id": session.id,
                    "title": session.title,
                    "runtime": session.runtime,
                    "runtimeName": session.runtimeName,
                    "cwd": session.cwd,
                },
                "items": [
                    item.model_dump(mode="json", exclude_none=True) for item in selected
                ],
            }
            share = await db.create_session_share(
                user_id=user_id,
                session_id=session_id,
                scope=payload.scope,
                snapshot=snapshot,
                allowed_file_ids=_attachment_file_ids(snapshot["items"]),
            )
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    share_path = f"/share/{share['id']}"
    return SessionShareCreateResponse(
        shareId=share["id"],
        sharePath=share_path,
        shareUrl=f"{_public_origin(request)}{share_path}",
        scope=payload.scope,
        createdAt=share["createdAt"],
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
    db: Store = Depends(get_store),
    attachments: AttachmentService = Depends(get_attachment_service),
) -> Response:
    share = await _share_or_404(db, share_id)
    if file_id not in set(share["allowedFileIds"]):
        raise HTTPException(status_code=404, detail="file not found")
    try:
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
