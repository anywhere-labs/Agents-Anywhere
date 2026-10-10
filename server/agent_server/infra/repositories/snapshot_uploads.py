from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, insert, select, update

from agent_server.core.models import TimelineItemIn
from agent_server.core.snapshot_upload import (
    CHUNK_BYTES,
    MAX_PENDING_BYTES,
    MAX_PENDING_UPLOADS,
    SnapshotUploadError,
    SnapshotUploadManifest,
)
from agent_server.core.timeline import TimelineBatchWriteResult
from agent_server.core.utc import utc_now
from agent_server.infra.db.schema import connector_snapshot_watermarks as watermarks
from agent_server.infra.db.schema import connector_upload_chunks as chunks
from agent_server.infra.db.schema import connector_uploads as uploads
from agent_server.infra.db.schema import sessions
from agent_server.infra.repositories.store_support import session_revision_fenced


class SnapshotUploadRepositoryMixin:
    async def purge_expired_snapshot_uploads(self) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(delete(uploads).where(uploads.c.expires_at < utc_now()))

    async def begin_snapshot_upload(self, connector_id: str, manifest: SnapshotUploadManifest) -> dict:
        now = utc_now()
        expires = (datetime.now(UTC) + timedelta(hours=24)).isoformat().replace("+00:00", "Z")
        async with self._engine.begin() as conn:
            await conn.execute(delete(uploads).where(uploads.c.expires_at < now))
            scope = (uploads.c.connector_id == connector_id, uploads.c.runtime_id == manifest.runtimeId,
                     uploads.c.session_id == manifest.sessionId)
            watermark_scope = (watermarks.c.connector_id == connector_id,
                               watermarks.c.runtime_id == manifest.runtimeId,
                               watermarks.c.session_id == manifest.sessionId)
            latest_seq = await conn.scalar(select(watermarks.c.through_seq).where(*watermark_scope))
            if latest_seq is not None and manifest.throughSeq < latest_seq:
                raise SnapshotUploadError(409, "Snapshot is older than the latest upload")
            row = (await conn.execute(select(uploads).where(uploads.c.connector_id == connector_id,
                uploads.c.upload_id == manifest.uploadId))).mappings().first()
            if row is not None:
                if (row["session_id"], row["runtime_id"], row["through_seq"], row["total_bytes"]) != (
                    manifest.sessionId, manifest.runtimeId, manifest.throughSeq, manifest.totalBytes,
                ):
                    raise SnapshotUploadError(409, "Upload manifest changed")
                if row["status"] == "superseded":
                    raise SnapshotUploadError(409, "Upload was superseded")
            else:
                previous = select(uploads.c.upload_id).where(*scope, uploads.c.status != "superseded")
                await conn.execute(delete(chunks).where(chunks.c.connector_id == connector_id,
                    chunks.c.upload_id.in_(previous)))
                await conn.execute(update(uploads).where(*scope).values(status="superseded"))
                pending_count, pending_size = (await conn.execute(select(func.count(), func.coalesce(func.sum(uploads.c.total_bytes), 0))
                    .where(uploads.c.connector_id == connector_id, uploads.c.status == "pending"))).one()
                if pending_count >= MAX_PENDING_UPLOADS or pending_size + manifest.totalBytes > MAX_PENDING_BYTES:
                    raise SnapshotUploadError(413, "Connector snapshot staging quota exceeded")
                await conn.execute(insert(uploads).values(connector_id=connector_id, upload_id=manifest.uploadId,
                    session_id=manifest.sessionId, runtime_id=manifest.runtimeId, through_seq=manifest.throughSeq,
                    total_bytes=manifest.totalBytes, status="pending", expires_at=expires))
                row = {"status": "pending"}
            if latest_seq is None:
                await conn.execute(insert(watermarks).values(connector_id=connector_id,
                    runtime_id=manifest.runtimeId, session_id=manifest.sessionId, through_seq=manifest.throughSeq))
            elif manifest.throughSeq > latest_seq:
                await conn.execute(update(watermarks).where(*watermark_scope).values(through_seq=manifest.throughSeq))
            indices = (await conn.execute(select(chunks.c.chunk_index).where(chunks.c.connector_id == connector_id,
                chunks.c.upload_id == manifest.uploadId).order_by(chunks.c.chunk_index))).scalars().all()
        return {"chunkBytes": CHUNK_BYTES, "receivedChunks": list(indices), "committed": row["status"] == "committed"}

    async def get_snapshot_upload(self, connector_id: str, upload_id: str) -> dict:
        async with self._engine.connect() as conn:
            row = (await conn.execute(select(uploads).where(uploads.c.connector_id == connector_id,
                uploads.c.upload_id == upload_id))).mappings().first()
        if row is None or row["expires_at"] < utc_now():
            raise SnapshotUploadError(404, "Unknown or expired snapshot upload")
        if row["status"] == "superseded":
            raise SnapshotUploadError(409, "Upload was superseded")
        return dict(row)

    async def put_snapshot_chunk(self, connector_id: str, upload_id: str, index: int, body: bytes) -> None:
        upload = await self.get_snapshot_upload(connector_id, upload_id)
        total = upload["total_bytes"]
        if index < 0 or index >= (total + CHUNK_BYTES - 1) // CHUNK_BYTES:
            raise SnapshotUploadError(400, "Invalid chunk index")
        if len(body) != min(CHUNK_BYTES, total - index * CHUNK_BYTES):
            raise SnapshotUploadError(400, "Invalid chunk length")
        if upload["status"] == "committed":
            raise SnapshotUploadError(409, "Upload already committed")
        async with self._engine.begin() as conn:
            existing = await conn.scalar(select(chunks.c.body).where(chunks.c.connector_id == connector_id,
                chunks.c.upload_id == upload_id, chunks.c.chunk_index == index))
            if existing is not None:
                if existing != body:
                    raise SnapshotUploadError(409, "Chunk content changed")
                return
            await conn.execute(insert(chunks).values(connector_id=connector_id, upload_id=upload_id,
                chunk_index=index, body=body))

    async def read_snapshot_chunks(self, connector_id: str, upload_id: str) -> AsyncIterator[tuple[int, bytes]]:
        async with self._engine.connect() as conn:
            query = select(chunks.c.chunk_index, chunks.c.body).where(chunks.c.connector_id == connector_id,
                chunks.c.upload_id == upload_id).order_by(chunks.c.chunk_index)
            async with conn.stream(query.execution_options(yield_per=8)) as result:
                async for index, body in result:
                    yield index, body

    @session_revision_fenced
    async def commit_snapshot_upload(
        self, connector_id: str, upload_id: str, *, session_id: str,
        metadata: dict, items: list[TimelineItemIn], source_observation: dict,
    ) -> TimelineBatchWriteResult:
        async with self._timeline_lock(session_id), self._engine.begin() as conn:
            upload = (await conn.execute(select(uploads).where(
                uploads.c.connector_id == connector_id, uploads.c.upload_id == upload_id,
            ))).mappings().first()
            if upload is None or upload["expires_at"] < utc_now():
                raise SnapshotUploadError(404, "Unknown or expired snapshot upload")
            if upload["status"] != "pending":
                raise SnapshotUploadError(409, "Upload is no longer pending")
            previous = (await conn.execute(select(sessions.c.connector_id, sessions.c.runtime_id,
                sessions.c.runtime, sessions.c.updated_seq).where(sessions.c.id == session_id))).first()
            fields = {
                "title": metadata.get("title"), "cwd": metadata.get("cwd"),
                "external_session_id": metadata["externalSessionId"],
                "last_synced_at": metadata.get("lastSyncedAt"),
                "source_observed_at": metadata.get("sourceObservedAt"),
                "last_activity_at": metadata.get("lastActivityAt"),
            }
            if previous is None:
                await self._write_connector_session(conn, connector_id=connector_id,
                    session_id=session_id, runtime="dsh", runtime_id=upload["runtime_id"], **fields)
            else:
                if (previous.connector_id, previous.runtime, previous.runtime_id) != (
                    connector_id, "dsh", upload["runtime_id"],
                ):
                    raise SnapshotUploadError(409, "Snapshot session binding does not match")
                await self._write_session_snapshot(conn, session_id=session_id,
                    mark_read_on_change=True, **fields)
            await self._write_session_source_state(conn, session_id=session_id, **source_observation)
            result = await self._replace_timeline_snapshot(conn, session_id=session_id, items=items,
                source_observed_at=metadata.get("sourceObservedAt"), mark_read_on_change=True)
            await conn.execute(update(uploads).where(uploads.c.connector_id == connector_id,
                uploads.c.upload_id == upload_id).values(status="committed"))
            await conn.execute(delete(chunks).where(chunks.c.connector_id == connector_id, chunks.c.upload_id == upload_id))
            next_seq = await conn.scalar(select(sessions.c.updated_seq).where(sessions.c.id == session_id))
        return TimelineBatchWriteResult(items=result.items,
            changed=previous is None or previous.updated_seq != next_seq)
