from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from agent_server.infra.fs_downloads import FsDownloadRelayManager, FsDownloadTransfer
from agent_server.services.connector_rpc import ConnectorProtocolError, ConnectorRpcPort


@dataclass(frozen=True, slots=True)
class PreparedConnectorDownload:
    result: dict[str, Any]
    transfer: FsDownloadTransfer


class ConnectorFileService:
    def __init__(
        self,
        gateway: ConnectorRpcPort,
        downloads: FsDownloadRelayManager,
    ) -> None:
        self._gateway = gateway
        self._downloads = downloads

    async def prepare_download(
        self,
        *,
        connector_id: str,
        scope_id: str,
        root: str,
        path: str,
    ) -> PreparedConnectorDownload:
        result = await self._gateway.request(
            connector_id,
            "fs.prepareDownload",
            {"sessionId": scope_id, "root": root, "path": path},
            timeout=30,
        )
        if not isinstance(result, dict):
            raise ConnectorProtocolError("invalid fs.prepareDownload response")
        transfer = await self._downloads.create(
            connector_id=connector_id,
            root=root,
            path=str(result.get("path") or path),
            name=str(result.get("name") or path.rsplit("/", 1)[-1] or "download"),
            size=int(result.get("size") or 0),
            sha256=str(result.get("sha256") or ""),
            media_type=str(result.get("mediaType") or "application/octet-stream"),
        )
        return PreparedConnectorDownload(result=result, transfer=transfer)

    async def request_upload(
        self,
        *,
        connector_id: str,
        scope_id: str,
        transfer: FsDownloadTransfer,
        upload_url: str,
    ) -> None:
        await self._gateway.request(
            connector_id,
            "fs.uploadPreparedDownload",
            {
                "sessionId": scope_id,
                "transferId": transfer.transfer_id,
                "token": transfer.token,
                "uploadUrl": upload_url,
                "root": transfer.root,
                "path": transfer.path,
            },
            timeout=10,
        )
