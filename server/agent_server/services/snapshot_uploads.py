from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
from collections.abc import AsyncIterator
from typing import Protocol

from agent_server.core.models import ConnectorIngestRequest, TimelineItemIn
from agent_server.core.snapshot_upload import CHUNK_BYTES, SnapshotUploadError
from agent_server.core.timeline import TimelineBatchWriteResult
from agent_server.services.connector_notifications import (
    session_meta_source_observation,
)


class SnapshotUploadRepository(Protocol):
    async def get_snapshot_upload(self, connector_id: str, upload_id: str) -> dict: ...
    def read_snapshot_chunks(self, connector_id: str, upload_id: str) -> AsyncIterator[tuple[int, bytes]]: ...
    async def get_unconfigured_runtime_ids(self, connector_id: str) -> set[str]: ...
    async def resolve_connector_session_id(
        self, *, connector_id: str, session_id: str, external_session_id: str,
        runtime: str, runtime_id: str,
    ) -> str: ...
    async def commit_snapshot_upload(
        self, connector_id: str, upload_id: str, *, session_id: str,
        metadata: dict, items: list[TimelineItemIn], source_observation: dict,
    ) -> TimelineBatchWriteResult: ...


class SnapshotUploadService:
    def __init__(self, store: SnapshotUploadRepository):
        self.store = store

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
        metadata = notices[0].params
        for field in ("title", "cwd", "lastSyncedAt", "sourceObservedAt", "lastActivityAt"):
            if metadata.get(field) is not None and not isinstance(metadata[field], str):
                raise SnapshotUploadError(400, f"Invalid snapshot metadata: {field}")
        history = params.get("items", [])
        if not isinstance(history, list):
            raise SnapshotUploadError(400, "Invalid snapshot history")
        try:
            items = [TimelineItemIn.model_validate(item) for item in history]
        except ValueError as exc:
            raise SnapshotUploadError(400, "Invalid snapshot history") from exc
        source_observation = session_meta_source_observation(metadata, "dsh")
        if upload["runtime_id"] in await self.store.get_unconfigured_runtime_ids(connector_id):
            raise SnapshotUploadError(409, "Snapshot runtime is not configured")
        try:
            session_id = await self.store.resolve_connector_session_id(
                connector_id=connector_id, session_id=upload["session_id"],
                external_session_id=external_id, runtime="dsh", runtime_id=upload["runtime_id"],
            )
        except KeyError:
            session_id = upload["session_id"]
        items = [
            item if item.sessionId == session_id
            else item.model_copy(update={"sessionId": session_id})
            for item in items
        ]
        try:
            await self.store.commit_snapshot_upload(
                connector_id, upload_id, session_id=session_id,
                metadata=metadata, items=items, source_observation=source_observation,
            )
        except SnapshotUploadError:
            raise
        except ValueError as exc:
            raise SnapshotUploadError(400, str(exc)) from exc
        return {"committed": True}
