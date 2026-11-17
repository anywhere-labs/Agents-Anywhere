"""Device-side byte transfers for v3 devices (``06-protocols.md`` §5).

``GET /api/v3/device/attachments/{fileId}?sessionId=`` -> a staged attachment (``X-File-Sha256``)
``PUT /api/v3/device/transfers/{transferId}``          -> the bytes of a ``Store/readBlob`` relay
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from starlette.requests import HTTPConnection

from agent_server.api.connector_ingress import _require_active_connector
from agent_server.api.device_link import V3_DEVICE_PREFIX
from agent_server.deps import get_attachment_service, get_fs_downloads, get_store
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.repositories.facade import Store
from agent_server.services.attachments import AttachmentService
from agent_server.services.device_blobs import DeviceBlobService

router = APIRouter(prefix=V3_DEVICE_PREFIX, tags=["device-transfers"])


def _safe_header_value(value: str) -> str:
    # HTTP header values must be latin-1; the device already knows the canonical name.
    return value.encode("latin-1", errors="replace").decode("latin-1")


def get_device_blobs(conn: HTTPConnection) -> DeviceBlobService:
    return conn.app.state.device_blobs


@router.get("/attachments/{file_id}")
async def device_attachment(
    file_id: str,
    session_id: str = Query(..., alias="sessionId"),
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
    attachments: AttachmentService = Depends(get_attachment_service),
    blobs: DeviceBlobService = Depends(get_device_blobs),
) -> Response:
    """A file a client uploaded for a session on this device; the device verifies ``X-File-Sha256``."""

    device_id = await _require_active_connector(authorization, db)
    try:
        path, metadata = await attachments.local_connector_file(
            session_id=session_id, file_id=file_id, connector_id=device_id
        )
        await blobs.note_staged(device_id, file_id, session_id)
        headers = {
            "X-File-Name": _safe_header_value(metadata.get("name") or file_id),
            "X-File-Sha256": str(metadata.get("sha256") or ""),
            "Cache-Control": "private, no-store",
        }
        media_type = str(metadata.get("mediaType") or "application/octet-stream")
        if path is not None:
            await attachments.verify_local_file(path, metadata)
            return FileResponse(path, media_type=media_type, headers=headers)
        data, _metadata = await attachments.read_connector_attachment(
            session_id=session_id, file_id=file_id, connector_id=device_id
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="file not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return Response(content=data, media_type=media_type, headers=headers)


@router.put("/transfers/{transfer_id}", status_code=204)
async def device_transfer_upload(
    transfer_id: str,
    request: Request,
    authorization: str = Header(..., alias="Authorization"),
    transfer_token: str = Header(..., alias="X-Transfer-Token"),
    db: Store = Depends(get_store),
    relay: FsDownloadRelayManager = Depends(get_fs_downloads),
) -> Response:
    """Stream the bytes a ``Store/readBlob`` call asked for; one use per transfer."""

    device_id = await _require_active_connector(authorization, db)
    transfer = await relay.get(transfer_id, transfer_token)
    if transfer is None or transfer.connector_id != device_id:
        raise HTTPException(status_code=404, detail="transfer not found")
    if not await relay.upload(transfer_id=transfer_id, token=transfer_token, chunks=request.stream()):
        raise HTTPException(status_code=410, detail="the reader went away")
    return Response(status_code=204)
