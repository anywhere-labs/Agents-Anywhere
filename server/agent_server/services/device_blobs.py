"""Large data between v3 devices and the Server (``06-protocols.md`` §5, ``03-architecture.md`` §3.6, §3.11).

Bytes never travel on MeshCall streams:

- **Device -> client** (attachments the device holds, share copies): the Server
  opens a one-time transfer on the existing relay (``FsDownloadRelayManager``,
  64 KiB x 8 through Redis), calls ``Store/readBlob`` with the transfer's id and
  token, and the device ``PUT``s the bytes to ``/api/v3/device/transfers/{tid}``.
  The first ``readBlob`` stream item carries the blob's name, media type, size
  and sha256; later items are progress.
- **Client -> device** (new attachments): the client uploads to the staging
  area as in v2; the device fetches ``GET /api/v3/device/attachments/{fileId}``
  and reports ``attachment.consumed`` through its outbox, after which the staged
  copy is deleted unless a share references it.
- **Shares**: ``Store/exportShare`` returns an immutable snapshot and the files
  it references; the Server keeps copies of those files for the public link.

Request payloads (``MethodPayload`` in device-meshcall 1.0, defined here):

- ``Store/readBlob``: ``{sessionId, blobRef, transfer: {transferId, token, path}}``;
  items ``{name, mediaType, size, sha256}`` first, then ``{progress}`` / ``{done: true}``.
- ``Store/exportShare``: ``{sessionId, selection: {scope, itemIds}, byteBudget}``;
  chunks ``{items: [...], attachments: [fileId...]}`` merged in order.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from loguru import logger

from agent_server.core.device_meshcall import (
    DEFAULT_BYTE_BUDGET,
    REQUEST_METHODS,
    MethodPayload,
    StreamChunk,
)
from agent_server.infra.device_link import DeviceLinkHub
from agent_server.infra.device_mesh import DeviceCallError, DeviceMesh
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.services.device_reads import DeviceReadError, DeviceReadTimeout

TRANSFER_PATH = "/api/v3/device/transfers/{transfer_id}"
STAGED_TTL_SECONDS = 7 * 24 * 3600
MAX_SHARE_FILE_BYTES = 25 * 1024 * 1024


@dataclass(frozen=True)
class BlobStream:
    name: str
    media_type: str
    size: int
    sha256: str
    chunks: AsyncIterator[bytes]


class DeviceBlobService:
    def __init__(
        self,
        store: Any,
        mesh: DeviceMesh,
        hub: DeviceLinkHub,
        relay: FsDownloadRelayManager,
        attachments: Any,
        coordinator: RedisCoordinator,
    ) -> None:
        self._store = store
        self._mesh = mesh
        self._hub = hub
        self._relay = relay
        self._attachments = attachments
        self._coordinator = coordinator
        self._staged: dict[tuple[str, str], str] = {}
        self._drains: set[asyncio.Task[None]] = set()

    # -- staging (client -> device) ----------------------------------------------

    def _staged_key(self, device_id: str, file_id: str) -> str:
        return self._coordinator.key("device-staged", device_id, file_id)

    async def note_staged(self, device_id: str, file_id: str, session_id: str) -> None:
        """Remember which session a file the device fetched belongs to (``attachment.consumed`` has no session)."""

        if not self._coordinator.distributed:
            self._staged[(device_id, file_id)] = session_id
            return
        await self._coordinator.client.set(self._staged_key(device_id, file_id), session_id, ex=STAGED_TTL_SECONDS)

    async def consumed(self, device_id: str, file_id: str, sha256: str) -> bool:
        """The device stored the file: drop the staged copy unless a share needs it. Idempotent."""

        if not self._coordinator.distributed:
            session_id = self._staged.pop((device_id, file_id), None)
        else:
            raw = await self._coordinator.client.getdel(self._staged_key(device_id, file_id))
            session_id = raw.decode() if isinstance(raw, bytes) else raw
        if not session_id:
            return False
        try:
            metadata = await self._attachments.staged_file_metadata(session_id=session_id, file_id=file_id)
        except KeyError:
            return False
        if str(metadata.get("sha256") or "") != sha256:
            logger.warning("attachment.consumed with another sha256 file_id={} device_id={}", file_id, device_id)
            return False
        if await self._store.file_referenced_by_share(session_id, file_id):
            return False
        await self._attachments.delete_file(session_id=session_id, file_id=file_id)
        return True

    # -- blobs (device -> client) ---------------------------------------------------

    async def open_blob(self, device_id: str, session_id: str, file_id: str) -> BlobStream | None:
        """Start a ``readBlob`` relay; None when the device is offline."""

        connection_id = await self._hub.current_connection(device_id)
        if connection_id is None:
            return None
        transfer = await self._relay.create(
            connector_id=device_id,
            root="device-blob",
            path=f"{session_id}/{file_id}",
            name=file_id,
            size=0,
            sha256="",
            media_type="application/octet-stream",
        )
        stream = self._mesh.stream(
            device_id,
            REQUEST_METHODS["store.readBlob"],
            MethodPayload(
                sessionId=session_id,
                blobRef=file_id,
                transfer={
                    "transferId": transfer.transfer_id,
                    "token": transfer.token,
                    "path": TRANSFER_PATH.format(transfer_id=transfer.transfer_id),
                },
            ),
            StreamChunk,
            connection_id=connection_id,
        )
        try:
            async with asyncio.timeout(self._mesh.settings.read_timeout_seconds):
                first = await anext(stream)
        except StopAsyncIteration:
            raise DeviceReadError("blob_unavailable", "the device sent no blob") from None
        except TimeoutError:
            await stream.aclose()
            raise DeviceReadTimeout() from None
        except DeviceCallError as exc:
            if exc.not_delivered:
                return None
            if exc.outcome_unknown:
                raise DeviceReadTimeout(exc.message or "the device did not answer in time") from exc
            raise DeviceReadError(exc.code, exc.message or exc.code) from exc
        head = first.chunk if isinstance(first.chunk, dict) else {}
        task = asyncio.create_task(self._drain(stream), name=f"device-blob-{transfer.transfer_id}")
        self._drains.add(task)
        task.add_done_callback(self._drains.discard)
        return BlobStream(
            name=str(head.get("name") or file_id),
            media_type=str(head.get("mediaType") or "application/octet-stream"),
            size=int(head.get("size") or 0),
            sha256=str(head.get("sha256") or ""),
            chunks=self._relay.stream(transfer_id=transfer.transfer_id, token=transfer.token),
        )

    async def _drain(self, stream: AsyncIterator[StreamChunk]) -> None:
        # Progress items; the bytes arrive over HTTP. Ending the stream early would cancel the upload.
        try:
            async for _item in stream:
                pass
        except DeviceCallError as exc:
            logger.info("device blob stream ended early error={}", exc)
        finally:
            with contextlib.suppress(Exception):
                await stream.aclose()  # type: ignore[attr-defined]

    async def read_blob_bytes(self, device_id: str, session_id: str, file_id: str, *, limit: int) -> tuple[bytes, BlobStream] | None:
        blob = await self.open_blob(device_id, session_id, file_id)
        if blob is None:
            return None
        parts: list[bytes] = []
        total = 0
        async for part in blob.chunks:
            total += len(part)
            if total > limit:
                raise DeviceReadError("blob_too_large", f"{file_id} exceeds {limit} bytes")
            parts.append(part)
        return b"".join(parts), blob

    # -- shares -------------------------------------------------------------------

    async def export_share(
        self, device_id: str, session_id: str, *, scope: str, item_ids: list[str]
    ) -> dict[str, Any] | None:
        """``{"items": [...], "attachments": [...]}``, or None when the device is offline."""

        connection_id = await self._hub.current_connection(device_id)
        if connection_id is None:
            return None
        items: list[Any] = []
        attachments: list[str] = []
        try:
            async for chunk in self._mesh.stream(
                device_id,
                REQUEST_METHODS["store.exportShare"],
                MethodPayload(
                    sessionId=session_id,
                    selection={"scope": scope, "itemIds": item_ids},
                    byteBudget=DEFAULT_BYTE_BUDGET * 8,
                ),
                StreamChunk,
                connection_id=connection_id,
                timeout=self._mesh.settings.read_timeout_seconds * 3,
            ):
                part = chunk.chunk if isinstance(chunk.chunk, dict) else json.loads(chunk.chunk)
                items.extend(part.get("items") or [])
                attachments.extend(fid for fid in part.get("attachments") or [] if isinstance(fid, str))
        except DeviceCallError as exc:
            if exc.not_delivered:
                return None
            if exc.outcome_unknown:
                raise DeviceReadTimeout(exc.message or "the device did not answer in time") from exc
            raise DeviceReadError(exc.code, exc.message or exc.code) from exc
        return {"items": items, "attachments": sorted(set(attachments))}

    async def copy_for_share(self, device_id: str, session_id: str, file_ids: list[str]) -> list[str]:
        """Make sure the Server holds every shared file; returns the ids that could not be copied."""

        missing: list[str] = []
        for file_id in file_ids:
            try:
                await self._attachments.staged_file_metadata(session_id=session_id, file_id=file_id)
                continue
            except KeyError:
                pass
            try:
                fetched = await self.read_blob_bytes(device_id, session_id, file_id, limit=MAX_SHARE_FILE_BYTES)
            except (DeviceReadError, DeviceReadTimeout) as exc:
                logger.warning("share attachment not copied file_id={} error={}", file_id, exc)
                missing.append(file_id)
                continue
            if fetched is None:
                missing.append(file_id)
                continue
            data, blob = fetched
            await self._attachments.save_share_copy(
                session_id=session_id,
                file_id=file_id,
                data=data,
                name=blob.name,
                media_type=blob.media_type,
                expected_sha256=blob.sha256 or None,
            )
        return missing

    async def close(self) -> None:
        for task in list(self._drains):
            task.cancel()
        await asyncio.gather(*self._drains, return_exceptions=True)
