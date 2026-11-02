from __future__ import annotations

import asyncio
import mimetypes
import urllib.parse
from pathlib import Path
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse, RedirectResponse, Response

from agent_server.core.auth import verify_signed_token, verify_user_access_token
from agent_server.core.models import (
    FsDownloadResponse,
    UploadedAttachment,
    UserUploadResponse,
)
from agent_server.core.utc import utc_now
from agent_server.deps import current_user_id, get_attachment_service, get_store
from agent_server.infra.files.base import UploadEmpty, UploadTooLarge
from agent_server.infra.repositories.facade import Store
from agent_server.services.attachments import (
    LOCAL_FILE_TOKEN_KIND,
    AttachmentService,
)
from agent_server.services.thumbnails import (
    DEFAULT_THUMBNAIL_WIDTH,
    ensure_thumbnail,
    is_supported_media_type,
    normalise_width,
)

router = APIRouter(prefix="/sessions", tags=["session-files"])


MAX_UPLOAD_FILES_PER_REQUEST = 5
MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024  # 25 MiB

_BACKGROUND_TASKS: set[asyncio.Task[None]] = set()


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
    request: Request,
    token: str | None = Query(None),
    authorization: str | None = Header(None, alias="Authorization"),
    attachments: AttachmentService = Depends(get_attachment_service),
) -> Response:
    try:
        user_id = _user_id_from_header(authorization=authorization, token=token)
        path, metadata = await attachments.local_user_file(
            session_id=session_id,
            file_id=file_id,
            user_id=user_id,
        )
        if path is not None:
            await attachments.verify_local_file(path, metadata)
            return _attachment_file_response(request, path, metadata)
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


@router.get("/{session_id}/attachments/{file_id}/thumb")
async def attachment_thumbnail(
    session_id: str,
    file_id: str,
    request: Request,
    token: str | None = Query(None),
    authorization: str | None = Header(None, alias="Authorization"),
    w: int = Query(DEFAULT_THUMBNAIL_WIDTH),
    attachments: AttachmentService = Depends(get_attachment_service),
) -> Response:
    """Serve a downscaled WebP preview of one stored image.

    The timeline renders images in a 196x142 dp box; without this the phone
    pulled the full-resolution photo for every bubble and scaled it after the
    bytes had already crossed the network. Widths snap to 256/512/1024 so the
    output stays immutably cacheable.
    """
    try:
        user_id = _user_id_from_header(authorization=authorization, token=token)
        path, metadata = await attachments.local_user_file(
            session_id=session_id,
            file_id=file_id,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="file not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    if path is None:
        raise HTTPException(status_code=404, detail="thumbnail unavailable")
    width = normalise_width(w)
    thumb = await ensure_thumbnail(path, width)
    if thumb is None:
        raise HTTPException(status_code=404, detail="thumbnail unavailable")
    return _thumbnail_response(request, thumb, metadata, width)


@router.get("/local/{session_id}/{file_id}", include_in_schema=False)
async def local_file_raw(
    session_id: str,
    file_id: str,
    request: Request,
    token: str,
    attachments: AttachmentService = Depends(get_attachment_service),
) -> Response:
    payload = verify_signed_token(LOCAL_FILE_TOKEN_KIND, token)
    if not payload or payload.get("sessionId") != session_id or payload.get("fileId") != file_id:
        raise HTTPException(status_code=401, detail="invalid file token")
    try:
        path, metadata = await attachments.local_signed_file(
            session_id=session_id,
            file_id=file_id,
        )
        if path is not None:
            await attachments.verify_local_file(path, metadata)
            return _attachment_file_response(request, path, metadata)
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
            "Content-Disposition": _content_disposition(
                "inline",
                metadata.get("name") or file_id,
            ),
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
        name = upload.filename or "attachment"
        media_type = upload.content_type or (mimetypes.guess_type(name)[0] or "")
        try:
            # Stream socket -> disk: a 25 MB photo used to become one 25 MB
            # bytes object here, and a batch of them stayed resident until the
            # response finished.
            saved = await attachments.save_user_upload_stream(
                session_id=session_id,
                user_id=user_id,
                name=name,
                source=upload.file,
                media_type=media_type,
                max_bytes=MAX_UPLOAD_FILE_BYTES,
            )
        except UploadEmpty:
            raise HTTPException(
                status_code=422, detail=f"file {name!r} is empty"
            ) from None
        except UploadTooLarge as exc:
            raise HTTPException(
                status_code=413,
                detail=f"file {name!r} exceeds {exc.limit} bytes",
            ) from None
        except KeyError:
            raise HTTPException(status_code=404, detail="session not found") from None
        finally:
            await upload.close()
        results.append(
            await attachments.uploaded_attachment_view(
                session_id=session_id,
                saved=saved,
                fallback_media_type=media_type,
            )
        )
        _schedule_thumbnail(attachments, session_id, saved)
    return UserUploadResponse(attachments=results, serverTime=utc_now())


def _content_disposition(disposition: str, filename: str) -> str:
    ascii_name = _ascii_filename_fallback(filename)
    utf8_name = urllib.parse.quote(filename, safe="")
    return f"{disposition}; filename={_quoted_filename(ascii_name)}; filename*=UTF-8''{utf8_name}"


def _ascii_filename_fallback(value: str) -> str:
    fallback = value.encode("ascii", errors="ignore").decode("ascii").strip()
    return fallback or "attachment"


def _quoted_filename(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', r"\"")
    return f'"{escaped}"'


def _safe_header_value(value: str) -> str:
    return value.encode("latin-1", errors="replace").decode("latin-1")


CACHE_CONTROL_IMMUTABLE = "private, max-age=31536000, immutable"


def _if_none_match(request: Request, sha256: str, cache_control: str) -> Response | None:
    """Answer a conditional GET with 304 so a cached blob is not re-sent.

    ``FileResponse`` only implements ``If-Range``; without this, a client that
    revalidates a cached photo would pull the whole file again.
    """
    if not sha256:
        return None
    etag = f'"{sha256}"'
    header = request.headers.get("if-none-match")
    if header:
        tags = {tag.strip() for tag in header.split(",")}
        if "*" in tags or etag in tags or f"W/{etag}" in tags:
            return Response(
                status_code=304,
                headers={"ETag": etag, "Cache-Control": cache_control},
            )
    return None


def _schedule_thumbnail(
    attachments: AttachmentService, session_id: str, saved: dict[str, Any]
) -> None:
    """Warm the preview in the background so the first timeline view is instant."""
    if not is_supported_media_type(saved.get("mediaType")):
        return
    task = asyncio.create_task(
        _warm_thumbnail(attachments, session_id, str(saved.get("fileId") or ""))
    )
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)


async def _warm_thumbnail(
    attachments: AttachmentService, session_id: str, file_id: str
) -> None:
    if not file_id:
        return
    try:
        path, _metadata = await attachments.local_signed_file(
            session_id=session_id, file_id=file_id
        )
        if path is None:
            return
        await ensure_thumbnail(path, DEFAULT_THUMBNAIL_WIDTH)
    except Exception:  # a missing preview must never fail the upload
        return


def _thumbnail_response(
    request: Request, path: Path, metadata: dict[str, Any], width: int
) -> Response:
    sha256 = str(metadata.get("sha256") or "")
    etag_seed = f"{sha256}-w{width}" if sha256 else ""
    not_modified = _if_none_match(request, etag_seed, CACHE_CONTROL_IMMUTABLE)
    if not_modified is not None:
        return not_modified
    original_name = str(metadata.get("name") or "")
    thumb_name = f"{Path(original_name).stem or 'image'}.webp"
    headers = {
        "Content-Disposition": _content_disposition("inline", thumb_name),
        "X-File-Sha256": sha256,
        "X-Thumbnail-Width": str(width),
        "Cache-Control": CACHE_CONTROL_IMMUTABLE,
    }
    if etag_seed:
        headers["ETag"] = f'"{etag_seed}"'
    return FileResponse(path, media_type="image/webp", headers=headers)


def _attachment_file_response(
    request: Request, path: Path, metadata: dict[str, Any]
) -> Response:
    """Stream one stored blob from disk.

    ``FileResponse`` answers single and multi-range requests and sets
    ``accept-ranges``/``last-modified``, so clients can resume a download or pull
    it in parallel chunks instead of restarting from byte zero.
    """
    name = str(metadata.get("name") or path.name)
    sha256 = str(metadata.get("sha256") or "")
    not_modified = _if_none_match(request, sha256, CACHE_CONTROL_IMMUTABLE)
    if not_modified is not None:
        return not_modified
    headers = {
        "Content-Disposition": _content_disposition("inline", name),
        "X-File-Name": _safe_header_value(name),
        "X-File-Sha256": sha256,
        # Blobs are content-addressed by sha256 and never rewritten, so the
        # client may keep them: reopening a session must not re-download photos.
        "Cache-Control": CACHE_CONTROL_IMMUTABLE,
    }
    if sha256:
        headers["ETag"] = f'"{sha256}"'
    return FileResponse(
        path,
        media_type=metadata.get("mediaType") or "application/octet-stream",
        headers=headers,
    )


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
