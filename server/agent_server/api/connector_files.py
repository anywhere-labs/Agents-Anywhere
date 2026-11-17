from __future__ import annotations

import urllib.parse
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from agent_server.api.client_forward import call as client_call
from agent_server.api.client_forward import (
    forward_connector,
    forwarding,
    owned_device,
    to_response,
)
from agent_server.api.connector_common import (
    connector_scope_id,
    raise_connector_service_error,
    require_owned_connector,
    require_owned_online_connector,
)
from agent_server.core.api_namespace import api_v2_path
from agent_server.core.auth import (
    create_signed_token,
    verify_signed_token,
)
from agent_server.core.device_meshcall import (
    DEVICE_TRANSFER_PATH,
    BlobTransfer,
    ClientServerFacts,
)
from agent_server.core.models import (
    FsPreviewReadRequest,
    FsPreviewReadTextRequest,
    FsPreviewSessionRequest,
    FsPreviewSessionResponse,
    FsPreviewTokenCreateResponse,
    FsReadRequest,
    FsReadTextRequest,
    FsReadTextResponse,
    FsWriteRequest,
    RpcResponsePayload,
)
from agent_server.core.utc import utc_now
from agent_server.deps import (
    authenticate_access_token,
    current_user_id,
    get_connector_file_service,
    get_fs_downloads,
    get_rpc,
    get_store,
)
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.repositories.facade import Store
from agent_server.services.connector_files import ConnectorFileService
from agent_server.services.connector_rpc import ConnectorServiceError
from agent_server.services.workspace import request_connector, resolve_workspace_path

router = APIRouter(prefix="/connectors", tags=["connector-files"])

FS_PREVIEW_OPEN_TOKEN_KIND = "fs_preview_open"
FS_PREVIEW_ACCESS_TOKEN_KIND = "fs_preview_access"
FS_PREVIEW_OPEN_EXPIRES_IN = 5 * 60
FS_PREVIEW_ACCESS_EXPIRES_IN = 15 * 60


async def _forward_fs_read(
    request: Request,
    *,
    route_id: str,
    user_id: str,
    connector_id: str,
    root: str,
    path: str,
    downloads: FsDownloadRelayManager,
    preview_access_token: str | None = None,
) -> Any:
    """``fs/read`` through ``Client/call``: the Server allocates the transfer, the device PUTs the bytes to it."""

    transfer = await downloads.create(
        connector_id=connector_id,
        root=root,
        path=path,
        name=path.rsplit("/", 1)[-1] or "download",
        size=0,
        sha256="",
        media_type="application/octet-stream",
        pushed=True,
    )
    answer = await client_call(
        request,
        route_id,
        user_id=user_id,
        device_id=connector_id,
        body={"path": path},
        path=api_v2_path(f"/connectors/{connector_id}/fs/read"),
        query={"root": root},
        server=ClientServerFacts(
            transfer=BlobTransfer(
                transferId=transfer.transfer_id,
                token=transfer.token,
                path=DEVICE_TRANSFER_PATH.format(transfer_id=transfer.transfer_id),
            )
        ),
        response_model=RpcResponsePayload,
    )
    if not answer.ok:
        return to_response(answer)
    result = dict(answer.body.get("result") or {}) if isinstance(answer.body, dict) else {}
    await downloads.describe(
        transfer,
        name=str(result.get("name") or transfer.name),
        size=int(result.get("size") or 0),
        sha256=str(result.get("sha256") or ""),
        media_type=str(result.get("mediaType") or "application/octet-stream"),
    )
    download_url = f"{api_v2_path(f'/connectors/{connector_id}/fs/transfers/{transfer.transfer_id}')}?token={transfer.token}"
    if preview_access_token is not None:
        download_url += f"&previewAccessToken={urllib.parse.quote(preview_access_token)}"
    return RpcResponsePayload(
        ok=True,
        result={**result, "transferId": transfer.transfer_id, "token": transfer.token, "downloadUrl": download_url},
    )


@router.post("/{connector_id}/fs/list", response_model=RpcResponsePayload)
async def connector_fs_list(
    request: Request,
    connector_id: str,
    payload: dict[str, Any] = Body(default_factory=dict),
    root: str | None = Query(default=None, min_length=1),
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    if (forwarded := await forward_connector(
        request, "connector.fs.list", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )) is not None:
        return forwarded
    connector = await require_owned_online_connector(
        connector_id, user_id, store, manager
    )
    root_value = root or payload.get("root")
    if not isinstance(root_value, str) or not root_value.strip():
        raise HTTPException(status_code=422, detail="root is required")
    raw_path = payload.get("path", ".")
    if not isinstance(raw_path, str):
        raise HTTPException(status_code=422, detail="path must be a string")
    path = (
        ""
        if connector.deviceOs == "windows" and raw_path == ""
        else resolve_workspace_path(root_value, raw_path)
    )
    result = await request_connector(
        manager,
        connector_id,
        "fs.readDir",
        {
            "sessionId": connector_scope_id(connector_id),
            "root": root_value,
            "path": path,
        },
        timeout=30,
    )
    return RpcResponsePayload(ok=True, result=result)


@router.post("/{connector_id}/fs/read", response_model=RpcResponsePayload)
async def connector_fs_read(
    request: Request,
    connector_id: str,
    payload: FsReadRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    files: ConnectorFileService = Depends(get_connector_file_service),
) -> RpcResponsePayload:
    if await owned_device(request, "connector.fs.read", user_id=user_id, connector_id=connector_id):
        return await _forward_fs_read(
            request, route_id="connector.fs.read", user_id=user_id, connector_id=connector_id, root=root,
            path=payload.path, downloads=request.app.state.fs_downloads,
        )
    await require_owned_online_connector(connector_id, user_id, store, manager)
    path = resolve_workspace_path(root, payload.path)
    try:
        prepared = await files.prepare_download(
            connector_id=connector_id,
            scope_id=connector_scope_id(connector_id),
            root=root,
            path=path,
        )
    except ConnectorServiceError as exc:
        raise_connector_service_error(exc)
    result = prepared.result
    transfer = prepared.transfer
    return RpcResponsePayload(
        ok=True,
        result={
            **result,
            "transferId": transfer.transfer_id,
            "token": transfer.token,
            "downloadUrl": f"{api_v2_path(f'/connectors/{connector_id}/fs/transfers/{transfer.transfer_id}')}?token={transfer.token}",
        },
    )


@router.post(
    "/{connector_id}/fs/preview-token", response_model=FsPreviewTokenCreateResponse
)
async def create_connector_fs_preview_token(
    connector_id: str,
    payload: FsReadRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
) -> FsPreviewTokenCreateResponse:
    await require_owned_connector(connector_id, user_id, store)
    path = resolve_workspace_path(root, payload.path)
    expires_at = _utc_now_plus_seconds(FS_PREVIEW_OPEN_EXPIRES_IN)
    preview_token = create_signed_token(
        FS_PREVIEW_OPEN_TOKEN_KIND,
        {
            "user_id": user_id,
            "connector_id": connector_id,
            "root": root,
            "path": path,
        },
        FS_PREVIEW_OPEN_EXPIRES_IN,
    )
    await store.record_fs_preview_token(
        token=preview_token,
        user_id=user_id,
        connector_id=connector_id,
        root=root,
        path=path,
        expires_at=expires_at,
    )
    return FsPreviewTokenCreateResponse(
        previewToken=preview_token,
        expiresAt=expires_at,
        serverTime=utc_now(),
    )


@router.post("/fs/preview-session", response_model=FsPreviewSessionResponse)
async def create_connector_fs_preview_session(
    payload: FsPreviewSessionRequest,
    store: Store = Depends(get_store),
) -> FsPreviewSessionResponse:
    token_payload = verify_signed_token(
        FS_PREVIEW_OPEN_TOKEN_KIND, payload.previewToken
    )
    if token_payload is None:
        raise HTTPException(status_code=400, detail="invalid preview token")
    user_id = str(token_payload.get("user_id") or "")
    connector_id = str(token_payload.get("connector_id") or "")
    root = str(token_payload.get("root") or "")
    path = str(token_payload.get("path") or "")
    if not user_id or not connector_id or not root or not path:
        raise HTTPException(status_code=400, detail="invalid preview token")
    consumed = await store.consume_fs_preview_token(
        token=payload.previewToken,
        user_id=user_id,
        connector_id=connector_id,
        root=root,
        path=path,
    )
    if not consumed:
        raise HTTPException(
            status_code=400, detail="preview token was already used or expired"
        )
    expires_at = _utc_now_plus_seconds(FS_PREVIEW_ACCESS_EXPIRES_IN)
    access_token = create_signed_token(
        FS_PREVIEW_ACCESS_TOKEN_KIND,
        {
            "user_id": user_id,
            "connector_id": connector_id,
            "root": root,
            "path": path,
        },
        FS_PREVIEW_ACCESS_EXPIRES_IN,
    )
    return FsPreviewSessionResponse(
        previewAccessToken=access_token,
        expiresAt=expires_at,
        connectorId=connector_id,
        root=root,
        path=path,
        serverTime=utc_now(),
    )


@router.post("/fs/preview/readText", response_model=FsReadTextResponse)
async def connector_fs_preview_read_text(
    request: Request,
    payload: FsPreviewReadTextRequest,
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> FsReadTextResponse:
    preview = _fs_preview_access_payload(payload.previewAccessToken)
    connector_id = preview["connector_id"]
    root = preview["root"]
    path = preview["path"]
    if forwarding(request, "connector.fs.preview.readText") and (forwarded := await forward_connector(
        request, "connector.fs.readText", user_id=preview["user_id"], connector_id=connector_id,
        response_model=FsReadTextResponse, body={"path": path, "maxBytes": payload.maxBytes},
        path=api_v2_path(f"/connectors/{connector_id}/fs/readText"), query={"root": root},
    )) is not None:
        return forwarded
    await require_owned_online_connector(
        connector_id, preview["user_id"], store, manager
    )
    result = await request_connector(
        manager,
        connector_id,
        "fs.readText",
        {
            "sessionId": connector_scope_id(connector_id),
            "root": root,
            "path": path,
            "maxBytes": payload.maxBytes,
        },
        timeout=30,
    )
    return FsReadTextResponse(**result, serverTime=utc_now())


@router.post("/fs/preview/read", response_model=RpcResponsePayload)
async def connector_fs_preview_read(
    request: Request,
    payload: FsPreviewReadRequest,
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    files: ConnectorFileService = Depends(get_connector_file_service),
) -> RpcResponsePayload:
    preview = _fs_preview_access_payload(payload.previewAccessToken)
    connector_id = preview["connector_id"]
    root = preview["root"]
    path = preview["path"]
    if forwarding(request, "connector.fs.preview.read") and await owned_device(
        request, "connector.fs.read", user_id=preview["user_id"], connector_id=connector_id
    ):
        return await _forward_fs_read(
            request, route_id="connector.fs.read", user_id=preview["user_id"], connector_id=connector_id, root=root,
            path=path, downloads=request.app.state.fs_downloads, preview_access_token=payload.previewAccessToken,
        )
    await require_owned_online_connector(
        connector_id, preview["user_id"], store, manager
    )
    try:
        prepared = await files.prepare_download(
            connector_id=connector_id,
            scope_id=connector_scope_id(connector_id),
            root=root,
            path=path,
        )
    except ConnectorServiceError as exc:
        raise_connector_service_error(exc)
    result = prepared.result
    transfer = prepared.transfer
    return RpcResponsePayload(
        ok=True,
        result={
            **result,
            "transferId": transfer.transfer_id,
            "token": transfer.token,
            "downloadUrl": (
                api_v2_path(
                    f"/connectors/{connector_id}/fs/transfers/{transfer.transfer_id}"
                )
                + f"?token={transfer.token}&previewAccessToken={urllib.parse.quote(payload.previewAccessToken)}"
            ),
        },
    )


@router.get("/{connector_id}/fs/transfers/{transfer_id}")
async def connector_fs_transfer_download(
    connector_id: str,
    transfer_id: str,
    token: str,
    request: Request,
    previewAccessToken: str | None = Query(default=None),
    authorization: str | None = Header(None, alias="Authorization"),
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    downloads: FsDownloadRelayManager = Depends(get_fs_downloads),
    files: ConnectorFileService = Depends(get_connector_file_service),
) -> StreamingResponse:
    transfer = await downloads.get(transfer_id, token)
    if previewAccessToken:
        preview = _fs_preview_access_payload(previewAccessToken)
        if (
            transfer is None
            or transfer.connector_id != connector_id
            or preview["connector_id"] != connector_id
            or preview["root"] != transfer.root
            or preview["path"] != transfer.path
        ):
            raise HTTPException(status_code=404, detail="transfer not found")
        user_id = preview["user_id"]
    else:
        user_id = await _user_id_from_authorization(request.app, authorization)
    await require_owned_online_connector(connector_id, user_id, store, manager)
    if transfer is None or transfer.connector_id != connector_id:
        raise HTTPException(status_code=404, detail="transfer not found")
    try:
        if not transfer.pushed:
            await files.request_upload(
                connector_id=connector_id,
                scope_id=connector_scope_id(connector_id),
                transfer=transfer,
                upload_url=api_v2_path(f"/connector/fs/transfers/{transfer.transfer_id}"),
            )
    except ConnectorServiceError as exc:
        raise_connector_service_error(exc)
    return StreamingResponse(
        downloads.stream(transfer_id=transfer_id, token=token),
        media_type=transfer.media_type or "application/octet-stream",
        headers={
            "Content-Disposition": _content_disposition(
                "attachment",
                transfer.name or transfer_id,
            ),
            "X-File-Name": _safe_header_value(transfer.name or transfer_id),
            "X-File-Sha256": transfer.sha256,
            "X-File-Size": str(transfer.size),
        },
    )


@router.post("/{connector_id}/fs/readText", response_model=FsReadTextResponse)
async def connector_fs_read_text(
    request: Request,
    connector_id: str,
    payload: FsReadTextRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> FsReadTextResponse:
    if (forwarded := await forward_connector(
        request, "connector.fs.readText", user_id=user_id, connector_id=connector_id, response_model=FsReadTextResponse
    )) is not None:
        return forwarded
    await require_owned_online_connector(connector_id, user_id, store, manager)
    path = resolve_workspace_path(root, payload.path)
    result = await request_connector(
        manager,
        connector_id,
        "fs.readText",
        {
            "sessionId": connector_scope_id(connector_id),
            "root": root,
            "path": path,
            "maxBytes": payload.maxBytes,
        },
        timeout=30,
    )
    return FsReadTextResponse(**result, serverTime=utc_now())


@router.post("/{connector_id}/fs/write", response_model=RpcResponsePayload)
async def connector_fs_write(
    request: Request,
    connector_id: str,
    payload: FsWriteRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    if (forwarded := await forward_connector(
        request, "connector.fs.write", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )) is not None:
        return forwarded
    await require_owned_online_connector(connector_id, user_id, store, manager)
    path = resolve_workspace_path(root, payload.path)
    params: dict = {
        "sessionId": connector_scope_id(connector_id),
        "root": root,
        "path": path,
        "content": payload.content,
        "encoding": payload.encoding,
    }
    if payload.ifMatch is not None:
        params["ifMatch"] = payload.ifMatch
    result = await request_connector(
        manager, connector_id, "fs.writeFile", params, timeout=30
    )
    return RpcResponsePayload(ok=True, result=result)


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


async def _user_id_from_authorization(app: Any, authorization: str | None) -> str:
    prefix = "Bearer "
    if authorization is None or not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="missing user access token")
    claims = await authenticate_access_token(app, authorization[len(prefix) :])
    if claims is None:
        raise HTTPException(status_code=401, detail="invalid user access token")
    return claims[0]


def _fs_preview_access_payload(token: str) -> dict[str, str]:
    payload = verify_signed_token(FS_PREVIEW_ACCESS_TOKEN_KIND, token)
    if payload is None:
        raise HTTPException(status_code=401, detail="invalid preview access token")
    user_id = str(payload.get("user_id") or "")
    connector_id = str(payload.get("connector_id") or "")
    root = str(payload.get("root") or "")
    path = str(payload.get("path") or "")
    if not user_id or not connector_id or not root or not path:
        raise HTTPException(status_code=401, detail="invalid preview access token")
    return {
        "user_id": user_id,
        "connector_id": connector_id,
        "root": root,
        "path": path,
    }


def _utc_now_plus_seconds(seconds: int) -> str:
    return (
        (datetime.now(UTC) + timedelta(seconds=seconds))
        .isoformat()
        .replace("+00:00", "Z")
    )
