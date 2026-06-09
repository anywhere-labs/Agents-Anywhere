from __future__ import annotations

import mimetypes

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File

from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.deps import current_user_id, get_attachment_service, get_rpc, get_store
from agent_server.core.models import (
    FsDownloadResponse,
    FsListRequest,
    FsReadRequest,
    FsReadTextRequest,
    FsReadTextResponse,
    FsWriteRequest,
    RpcResponsePayload,
    UploadedAttachment,
    UserUploadResponse,
)
from agent_server.services.workspace import (
    local_rpc_session,
    request_connector,
    resolve_workspace_path,
)
from agent_server.services.attachments import AttachmentService
from agent_server.infra.repositories.facade import Store
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/sessions", tags=["sessions-fs"])


MAX_UPLOAD_FILES_PER_REQUEST = 5
MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024  # 25 MiB


@router.post("/{session_id}/fs/read", response_model=RpcResponsePayload)
async def fs_read(
    session_id: str,
    payload: FsReadRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    session = await local_rpc_session(session_id, user_id, db, manager)
    path = resolve_workspace_path(session.cwd, payload.path)
    result = await request_connector(
        manager,
        session.connectorId,
        "fs.readFile",
        {
            "sessionId": session.id,
            "root": session.cwd,
            "path": path,
        },
        timeout=30,
    )
    return RpcResponsePayload(ok=True, result=result)


@router.get("/{session_id}/fs/downloads/{file_id}", response_model=FsDownloadResponse)
async def fs_download(
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


@router.post("/{session_id}/uploads", response_model=UserUploadResponse)
async def user_uploads(
    session_id: str,
    files: list[UploadFile] = File(...),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    attachments: AttachmentService = Depends(get_attachment_service),
) -> UserUploadResponse:
    """User-driven attachment upload — files staged on the backend for the agent
    to pick up via the connector. One blob per uploaded file. The bytes get
    deleted from disk as soon as the connector has consumed them (see
    `/connector/fs/downloads/{file_id}`)."""
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


@router.post("/{session_id}/fs/write", response_model=RpcResponsePayload)
async def fs_write(
    session_id: str,
    payload: FsWriteRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    session = await local_rpc_session(session_id, user_id, db, manager)
    path = resolve_workspace_path(session.cwd, payload.path)
    params: dict = {
        "sessionId": session.id,
        "root": session.cwd,
        "path": path,
        "content": payload.content,
        "encoding": payload.encoding,
    }
    if payload.ifMatch is not None:
        params["ifMatch"] = payload.ifMatch
    try:
        result = await request_connector(
            manager,
            session.connectorId,
            "fs.writeFile",
            params,
            timeout=30,
        )
    except HTTPException as exc:
        # Translate the connector's "stale" error into a 412 so the browser
        # can show a "the file changed under you" message.
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        if exc.status_code == 502 and detail.get("code") == "stale":
            raise HTTPException(status_code=412, detail=detail) from exc
        raise
    return RpcResponsePayload(ok=True, result=result)


@router.post("/{session_id}/fs/readText", response_model=FsReadTextResponse)
async def fs_read_text(
    session_id: str,
    payload: FsReadTextRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> FsReadTextResponse:
    session = await local_rpc_session(session_id, user_id, db, manager)
    path = resolve_workspace_path(session.cwd, payload.path)
    result = await request_connector(
        manager,
        session.connectorId,
        "fs.readText",
        {
            "sessionId": session.id,
            "root": session.cwd,
            "path": path,
            "maxBytes": payload.maxBytes,
        },
        timeout=30,
    )
    return FsReadTextResponse(**result, serverTime=utc_now())


@router.post("/{session_id}/fs/list", response_model=RpcResponsePayload)
async def fs_list(
    session_id: str,
    payload: FsListRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    session = await local_rpc_session(session_id, user_id, db, manager)
    path = resolve_workspace_path(session.cwd, payload.path or ".")
    result = await request_connector(
        manager,
        session.connectorId,
        "fs.readDir",
        {
            "sessionId": session.id,
            "root": session.cwd,
            "path": path,
        },
        timeout=30,
    )
    return RpcResponsePayload(ok=True, result=result)
