from __future__ import annotations

import mimetypes

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Header, Query
from fastapi.responses import RedirectResponse, Response

from agent_server.deps import current_user_id, get_attachment_service, get_store
from agent_server.core.models import (
    FsDownloadResponse,
    UploadedAttachment,
    UserUploadResponse,
)
from agent_server.services.attachments import (
    AttachmentService,
    LOCAL_FILE_TOKEN_KIND,
)
from agent_server.infra.repositories.facade import Store
from agent_server.core.auth import verify_signed_token, verify_user_access_token
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/sessions", tags=["session-files"])


MAX_UPLOAD_FILES_PER_REQUEST = 5
MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024  # 25 MiB


@router.get("/{session_id}/attachments/{file_id}", response_model=FsDownloadResponse)
async def attachment_download(
    session_id: str,
    file_id: str,
    user_id: str = Depends(current_user_id),
    attachments: AttachmentService = Depends(get_attachment_service),
) -> FsDownloadResponse:
    try:
        downloaded = await attachments.read_user_file(
            session_id=session_id,
            file_id=file_id,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="file not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return FsDownloadResponse(**downloaded, serverTime=utc_now())


@router.get("/{session_id}/attachments/{file_id}/open")
async def attachment_open(
    session_id: str,
    file_id: str,
    token: str | None = Query(None),
    authorization: str | None = Header(None, alias="Authorization"),
    attachments: AttachmentService = Depends(get_attachment_service),
) -> RedirectResponse:
    try:
        user_id = _user_id_from_header(authorization=authorization, token=token)
        url = await attachments.user_file_open_url(
            session_id=session_id,
            file_id=file_id,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="file not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return RedirectResponse(url=url, status_code=302)


@router.get("/local/{session_id}/{file_id}", include_in_schema=False)
async def local_file_raw(
    session_id: str,
    file_id: str,
    token: str,
    attachments: AttachmentService = Depends(get_attachment_service),
) -> Response:
    payload = verify_signed_token(LOCAL_FILE_TOKEN_KIND, token)
    if not payload or payload.get("sessionId") != session_id or payload.get("fileId") != file_id:
        raise HTTPException(status_code=401, detail="invalid file token")
    try:
        data, metadata = await attachments.read_local_signed_file(
            session_id=session_id,
            file_id=file_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="file not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return Response(
        content=data,
        media_type=metadata.get("mediaType") or "application/octet-stream",
        headers={
            "Content-Disposition": f"inline; filename={_quoted_filename(metadata.get('name') or file_id)}",
            "X-File-Name": _safe_header_value(metadata.get("name") or file_id),
            "X-File-Sha256": str(metadata.get("sha256") or ""),
        },
    )


@router.post("/{session_id}/attachments", response_model=UserUploadResponse)
async def create_attachments(
    session_id: str,
    files: list[UploadFile] = File(...),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    attachments: AttachmentService = Depends(get_attachment_service),
) -> UserUploadResponse:
    """User-driven attachment upload — files staged on the backend for the agent
    to pick up via the connector. One blob per uploaded file."""
    if not files:
        raise HTTPException(status_code=422, detail="no files were uploaded")
    if len(files) > MAX_UPLOAD_FILES_PER_REQUEST:
        raise HTTPException(
            status_code=422,
            detail=f"at most {MAX_UPLOAD_FILES_PER_REQUEST} files per request",
        )
    try:
        await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None

    results: list[UploadedAttachment] = []
    for upload in files:
        data = await upload.read()
        if len(data) == 0:
            raise HTTPException(
                status_code=422, detail=f"file {upload.filename!r} is empty"
            )
        if len(data) > MAX_UPLOAD_FILE_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"file {upload.filename!r} exceeds {MAX_UPLOAD_FILE_BYTES} bytes"
                ),
            )
        name = upload.filename or "attachment"
        media_type = upload.content_type or (mimetypes.guess_type(name)[0] or "")
        try:
            saved = await attachments.save_user_upload(
                session_id=session_id,
                user_id=user_id,
                name=name,
                data=data,
                media_type=media_type,
            )
        except KeyError:
            raise HTTPException(status_code=404, detail="session not found") from None
        results.append(
            await attachments.uploaded_attachment_view(
                session_id=session_id,
                saved=saved,
                fallback_media_type=media_type,
            )
        )
    return UserUploadResponse(attachments=results, serverTime=utc_now())


def _quoted_filename(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', r"\"")
    return f'"{escaped}"'


def _safe_header_value(value: str) -> str:
    return value.encode("latin-1", errors="replace").decode("latin-1")


def _user_id_from_header(
    *,
    authorization: str | None,
    token: str | None = None,
) -> str:
    prefix = "Bearer "
    if authorization and authorization.startswith(prefix):
        user_id = verify_user_access_token(authorization[len(prefix) :])
        if user_id is not None:
            return user_id
    if token:
        user_id = verify_user_access_token(token)
        if user_id is not None:
            return user_id
    raise HTTPException(status_code=401, detail="invalid user access token")
