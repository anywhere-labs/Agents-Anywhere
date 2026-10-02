from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
from collections.abc import AsyncIterator
from typing import Protocol

from agent_server.core.models import ConnectorIngestRequest
from agent_server.core.snapshot_upload import CHUNK_BYTES, SnapshotUploadError
from agent_server.services.connector_ingest import ConnectorIngestService


class SnapshotUploadRepository(Protocol):
    async def get_snapshot_upload(self, connector_id: str, upload_id: str) -> dict: ...
    def read_snapshot_chunks(self, connector_id: str, upload_id: str) -> AsyncIterator[tuple[int, bytes]]: ...
    async def complete_snapshot_upload(self, connector_id: str, upload_id: str) -> None: ...


class SnapshotUploadService:
    def __init__(self, store: SnapshotUploadRepository, ingest: ConnectorIngestService):
        self.store, self.ingest = store, ingest

    async def commit(self, connector_id: str, upload_id: str) -> dict:
        upload = await self.store.get_snapshot_upload(connector_id, upload_id)
        if upload["status"] == "committed":
            return {"committed": True}
        digest = hashlib.sha256()
        with tempfile.TemporaryFile(mode="w+b") as body:
            count = 0
            async for index, chunk in self.store.read_snapshot_chunks(connector_id, upload_id):
                if index != count:
                    raise SnapshotUploadError(409, "Snapshot has missing chunks")
                count += 1
                digest.update(chunk)
                body.write(chunk)
            if count != (upload["total_bytes"] + CHUNK_BYTES - 1) // CHUNK_BYTES:
                raise SnapshotUploadError(409, "Snapshot has missing chunks")
            if digest.hexdigest() != upload_id or body.tell() != upload["total_bytes"]:
                raise SnapshotUploadError(400, "Snapshot digest mismatch")
            body.seek(0)
            try:
                # Parsing remains whole-body; transport staging does not bound Server JSON memory.
                task = asyncio.create_task(asyncio.to_thread(lambda: ConnectorIngestRequest.model_validate(json.load(body))))
                try:
                    payload = await asyncio.shield(task)
                except asyncio.CancelledError:
                    await task
                    raise
            except ValueError as exc:
                raise SnapshotUploadError(400, "Invalid snapshot JSON") from exc
        notices = payload.notifications
        if len(notices) != 2 or [n.method for n in notices] != ["session.meta.upsert", "timeline.sync"]:
            raise SnapshotUploadError(400, "Upload must contain one complete snapshot")
        for notice in notices:
            params = notice.params
            if params.get("runtime") != "dsh" or params.get("runtimeId") != upload["runtime_id"] or params.get("sessionId") != upload["session_id"]:
                raise SnapshotUploadError(400, "Snapshot binding does not match manifest")
        params = notices[1].params
        external_id = params.get("externalSessionId")
        if (
            params.get("complete") is not True
            or type(params.get("snapshotSeq")) is not int
            or params["snapshotSeq"] != upload["through_seq"]
            or not isinstance(external_id, str) or not external_id
            or external_id != notices[0].params.get("externalSessionId")
        ):
            raise SnapshotUploadError(400, "Incomplete or inconsistent snapshot")
        result = await self.ingest.ingest(connector_id=connector_id, payload=payload)
        if result.rejected:
            return {"committed": False, "rejected": [r.model_dump() for r in result.rejected]}
        await self.store.complete_snapshot_upload(connector_id, upload_id)
        return {"committed": True}
