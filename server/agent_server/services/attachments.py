from __future__ import annotations

import asyncio
import base64
import hashlib
import secrets
from pathlib import Path
from typing import Any, BinaryIO

from agent_server.core.api_namespace import api_v2_path
from agent_server.core.auth import create_signed_token
from agent_server.core.models import UploadedAttachment
from agent_server.core.utc import utc_now
from agent_server.infra.files import FileStorage
from agent_server.services.thumbnails import is_supported_media_type

LOCAL_FILE_TOKEN_KIND = "local_file"
LOCAL_FILE_TOKEN_EXPIRES_IN = 300
FILE_OPEN_EXPIRES_IN = 300


class AttachmentService:
    def __init__(self, store: Any, files: FileStorage) -> None:
        self._store = store
        self._files = files

    async def save_user_upload(
        self,
        *,
        session_id: str,
        user_id: str,
        name: str,
        data: bytes,
        media_type: str | None = None,
        file_id: str | None = None,
    ) -> dict[str, Any]:
        async with self._store.attachment_write_fence(session_id, user_id=user_id):
            return await self._persist_file_blob(
                session_id=session_id,
                data=data,
                name=name,
                media_type=media_type,
                origin="user",
                file_id=file_id,
            )

    async def save_user_upload_stream(
        self,
        *,
        session_id: str,
        user_id: str,
        name: str,
        source: BinaryIO,
        media_type: str | None = None,
        max_bytes: int | None = None,
    ) -> dict[str, Any]:
        """Stage an upload straight from the request stream onto disk.

        Same contract as :meth:`save_user_upload`, but the bytes are copied in
        chunks: a batch of 25 MB photos no longer turns into the same number of
        bytes objects inside the worker process.
        """
        async with self._store.attachment_write_fence(session_id, user_id=user_id):
            file_id = f"file_{secrets.token_urlsafe(12)}"
            metadata = self._file_metadata(
                file_id=file_id,
                session_id=session_id,
                name=name,
                media_type=media_type,
                origin="user",
            )
            return await self._files.write_stream(
                session_id,
                file_id,
                source,
                metadata,
                max_bytes=max_bytes,
            )

    async def read_user_file(
        self,
        *,
        session_id: str,
        file_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        await self._store.get_session(session_id, user_id=user_id)
        self._validate_file_id(file_id)
        data, metadata = await self._files.read(session_id, file_id)
        self._validate_blob_integrity(data, metadata)
        return {
            **metadata,
            "contentBase64": base64.b64encode(data).decode("ascii"),
        }

    async def read_local_signed_file(
        self,
        *,
        session_id: str,
        file_id: str,
    ) -> tuple[bytes, dict[str, Any]]:
        self._validate_file_id(file_id)
        data, metadata = await self._files.read(session_id, file_id)
        self._validate_blob_integrity(data, metadata)
        return data, metadata


    async def verify_local_file(self, path: Path, metadata: dict[str, Any]) -> None:
        """Validate the on-disk blob before handing it to FileResponse.

        Streaming responses must keep the same integrity guarantee as the
        byte-reading path. The check is chunked and runs in a worker thread so
        a large upload cannot block the event loop or double peak memory.
        """
        expected = str(metadata.get("sha256") or "")
        if not expected:
            return

        def digest() -> str:
            hasher = hashlib.sha256()
            with path.open("rb") as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    hasher.update(chunk)
            return hasher.hexdigest()

        actual = await asyncio.to_thread(digest)
        if not secrets.compare_digest(actual, expected):
            raise ValueError("attachment integrity check failed")

    async def local_signed_file(
        self,
        *,
        session_id: str,
        file_id: str,
    ) -> tuple[Path | None, dict[str, Any]]:
        """Return (blob path, metadata); path is None for remote backends."""
        self._validate_file_id(file_id)
        metadata = await self._files.metadata(session_id, file_id)
        return await self._files.local_path(session_id, file_id), metadata

    async def local_user_file(
        self,
        *,
        session_id: str,
        file_id: str,
        user_id: str,
    ) -> tuple[Path | None, dict[str, Any]]:
        """Authorize a user download and return (blob path, metadata)."""
        await self._store.get_session(session_id, user_id=user_id)
        return await self.local_signed_file(session_id=session_id, file_id=file_id)

    async def local_connector_file(
        self,
        *,
        session_id: str,
        file_id: str,
        connector_id: str,
    ) -> tuple[Path | None, dict[str, Any]]:
        """Authorize a connector download and return (blob path, metadata)."""
        self._validate_file_id(file_id)
        if not await self._store.session_owned_by_connector(session_id, connector_id):
            raise KeyError(session_id)
        metadata = await self._files.metadata(session_id, file_id)
        return await self._files.local_path(session_id, file_id), metadata

    async def read_shared_file(
        self,
        *,
        session_id: str,
        file_id: str,
    ) -> tuple[bytes, dict[str, Any]]:
        self._validate_file_id(file_id)
        data, metadata = await self._files.read(session_id, file_id)
        self._validate_blob_integrity(data, metadata)
        return data, metadata

    async def user_file_metadata(
        self,
        *,
        session_id: str,
        file_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        await self._store.get_session(session_id, user_id=user_id)
        self._validate_file_id(file_id)
        return await self._files.metadata(session_id, file_id)

    async def user_file_open_url(
        self,
        *,
        session_id: str,
        file_id: str,
        user_id: str,
    ) -> str:
        await self.user_file_metadata(
            session_id=session_id,
            file_id=file_id,
            user_id=user_id,
        )
        return await self.signed_file_open_url(session_id=session_id, file_id=file_id)

    async def signed_file_open_url(
        self,
        *,
        session_id: str,
        file_id: str,
    ) -> str:
        self._validate_file_id(file_id)
        native = await self._files.open_url(
            session_id,
            file_id,
            expires_in=FILE_OPEN_EXPIRES_IN,
        )
        if native is not None:
            return native.url
        token = create_signed_token(
            LOCAL_FILE_TOKEN_KIND,
            {"sessionId": session_id, "fileId": file_id},
            LOCAL_FILE_TOKEN_EXPIRES_IN,
        )
        return f"{api_v2_path(f'/sessions/local/{session_id}/{file_id}')}?token={token}"

    async def read_connector_attachment(
        self,
        *,
        session_id: str,
        file_id: str,
        connector_id: str,
    ) -> tuple[bytes, dict[str, Any]]:
        self._validate_file_id(file_id)
        if not await self._store.session_owned_by_connector(session_id, connector_id):
            raise KeyError(session_id)
        data, metadata = await self._files.read(session_id, file_id)
        self._validate_blob_integrity(data, metadata)
        return data, metadata

    async def delete_file(self, *, session_id: str, file_id: str) -> None:
        self._validate_file_id(file_id)
        await self._files.delete(session_id, file_id)

    async def uploaded_attachment_view(
        self,
        *,
        session_id: str,
        saved: dict[str, Any],
        fallback_media_type: str,
    ) -> UploadedAttachment:
        media_type = saved.get("mediaType") or fallback_media_type
        # Thumbnails are generated from an on-disk blob. Remote/object backends
        # cannot serve the local thumbnail route yet, so do not advertise a URL
        # that would 404 for them.
        has_local_blob = await self._files.local_path(session_id, saved["fileId"]) is not None
        return UploadedAttachment(
            fileId=saved["fileId"],
            sessionId=session_id,
            name=saved["name"],
            size=saved["size"],
            sha256=saved["sha256"],
            mediaType=media_type,
            createdAt=saved["createdAt"],
            downloadUrl=api_v2_path(f"/sessions/{session_id}/attachments/{saved['fileId']}"),
            openUrl=api_v2_path(f"/sessions/{session_id}/attachments/{saved['fileId']}/open"),
            thumbnailUrl=(
                api_v2_path(
                    f"/sessions/{session_id}/attachments/{saved['fileId']}/thumb?w=512"
                )
                if has_local_blob and is_supported_media_type(media_type)
                else ""
            ),
        )

    async def _persist_file_blob(
        self,
        *,
        session_id: str,
        data: bytes,
        name: str | None,
        source_path: str | None = None,
        media_type: str | None = None,
        origin: str,
        file_id: str | None = None,
    ) -> dict[str, Any]:
        file_id = file_id or f"file_{secrets.token_urlsafe(12)}"
        self._validate_file_id(file_id)
        metadata = self._file_metadata(
            file_id=file_id,
            session_id=session_id,
            name=name,
            source_path=source_path,
            media_type=media_type,
            origin=origin,
            size=len(data),
            sha256=hashlib.sha256(data).hexdigest(),
        )
        await self._files.write(session_id, file_id, data, metadata)
        return metadata

    @staticmethod
    def _file_metadata(
        *,
        file_id: str,
        session_id: str,
        name: str | None,
        media_type: str | None,
        origin: str,
        source_path: str | None = None,
        size: int = 0,
        sha256: str = "",
    ) -> dict[str, Any]:
        return {
            "fileId": file_id,
            "sessionId": session_id,
            "path": source_path or "",
            "name": name or file_id,
            "size": size,
            "sha256": sha256,
            "mediaType": media_type or "",
            "origin": origin,
            "createdAt": utc_now(),
        }

    @staticmethod
    def _validate_file_id(file_id: str) -> None:
        if "/" in file_id or "\\" in file_id or not file_id.startswith("file_"):
            raise KeyError(file_id)

    @staticmethod
    def _validate_blob_integrity(data: bytes, metadata: dict[str, Any]) -> None:
        actual_sha256 = hashlib.sha256(data).hexdigest()
        if actual_sha256 != metadata.get("sha256") or len(data) != metadata.get("size"):
            raise ValueError("stored file metadata does not match content")


class AttachmentMaterializer:
    """Runtime input helper for future driver-specific attachment handoff."""

    @staticmethod
    def path_hint(metadata: dict[str, Any], path: str) -> str:
        name = metadata.get("name") or metadata.get("fileId") or "attachment"
        media_type = metadata.get("mediaType") or "application/octet-stream"
        size = metadata.get("size") or 0
        return f"[Attached file: {name} ({media_type}, {size} bytes) at {path}]"
