from __future__ import annotations

import urllib.parse
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from agent_server.api.client_forward import call as client_call
from agent_server.api.client_forward import (
    forward_connector,
    owned_device,
    to_response,
)
from agent_server.api.connector_common import (
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
    ClientPreview,
    ClientServerFacts,
    ClientTransfer,
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
from agent_server.core.workspace_paths import resolve_workspace_path
from agent_server.deps import (
    authenticate_access_token,
    current_user_id,
    get_connector_presence,
    get_fs_downloads,
    get_store,
)
from agent_server.infra.connector_presence_registry import ConnectorPresenceRegistry
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.repositories.facade import Store

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
    """``fs/read`` through ``Client/call``: the Server allocates the transfer, the device PUTs the bytes to it.

    The relay takes the upload before the client asks for it (bounded: the device's ``PUT`` waits for the reader).
    """

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
    download_url = f"{api_v2_path(f'/connectors/{connector_id}/fs/transfers/{transfer.transfer_id}')}?token={transfer.token}"
    if preview_access_token is not None:
        download_url += f"&previewAccessToken={urllib.parse.quote(preview_access_token)}"
    answer = await client_call(
        request,
        route_id,
        user_id=user_id,
        device_id=connector_id,
        body={"path": path},
        path=api_v2_path(f"/connectors/{connector_id}/fs/read"),
        query={"root": root},
        server=ClientServerFacts(
            transfer=ClientTransfer(
                transferId=transfer.transfer_id,
                token=transfer.token,
                path=DEVICE_TRANSFER_PATH.format(transfer_id=transfer.transfer_id),
                downloadUrl=download_url,
            ),
            **({"preview": ClientPreview(root=root, path=path)} if preview_access_token is not None else {}),
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
) -> Any:
    return await forward_connector(
        request, "connector.fs.list", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )


@router.post("/{connector_id}/fs/read", response_model=RpcResponsePayload)
async def connector_fs_read(
    request: Request,
    connector_id: str,
    payload: FsReadRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    downloads: FsDownloadRelayManager = Depends(get_fs_downloads),
) -> Any:
    await owned_device(request, user_id=user_id, connector_id=connector_id)
    return await _forward_fs_read(
        request, route_id="connector.fs.read", user_id=user_id, connector_id=connector_id, root=root,
        path=payload.path, downloads=downloads,
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
) -> Any:
    preview = _fs_preview_access_payload(payload.previewAccessToken)
    connector_id = preview["connector_id"]
    root = preview["root"]
    path = preview["path"]
    return await forward_connector(
        request, "connector.fs.readText", user_id=preview["user_id"], connector_id=connector_id,
        response_model=FsReadTextResponse, body={"path": path, "maxBytes": payload.maxBytes},
        path=api_v2_path(f"/connectors/{connector_id}/fs/readText"), query={"root": root},
        server=ClientServerFacts(preview=ClientPreview(root=root, path=path)),
    )


@router.post("/fs/preview/read", response_model=RpcResponsePayload)
async def connector_fs_preview_read(
    request: Request,
    payload: FsPreviewReadRequest,
    downloads: FsDownloadRelayManager = Depends(get_fs_downloads),
) -> Any:
    preview = _fs_preview_access_payload(payload.previewAccessToken)
    connector_id = preview["connector_id"]
    await owned_device(request, user_id=preview["user_id"], connector_id=connector_id)
    return await _forward_fs_read(
        request, route_id="connector.fs.read", user_id=preview["user_id"], connector_id=connector_id,
        root=preview["root"], path=preview["path"], downloads=downloads,
        preview_access_token=payload.previewAccessToken,
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
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    downloads: FsDownloadRelayManager = Depends(get_fs_downloads),
) -> StreamingResponse:
    """The bytes of a ``fs/read`` transfer, relayed while the device ``PUT``s them (``api.device_transfers``)."""

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
) -> Any:
    return await forward_connector(
        request, "connector.fs.readText", user_id=user_id, connector_id=connector_id, response_model=FsReadTextResponse
    )


@router.post("/{connector_id}/fs/write", response_model=RpcResponsePayload)
async def connector_fs_write(
    request: Request,
    connector_id: str,
    payload: FsWriteRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.fs.write", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )


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
