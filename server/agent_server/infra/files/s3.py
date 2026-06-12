from __future__ import annotations

import json
from typing import Any

from agent_server.infra.files.base import FileOpenUrl, FileStorage


class S3FileStorage(FileStorage):
    """S3-backed storage using the internal httpx-s3-client package."""

    def __init__(
        self,
        *,
        bucket: str,
        prefix: str,
        access_key: str,
        secret_key: str,
        region: str,
        endpoint_url: str | None,
        virtual_host_style: bool,
    ) -> None:
        try:
            from httpx_s3_client import AsyncS3Client, S3Config
        except ModuleNotFoundError as exc:  # pragma: no cover - depends on deployment env
            raise RuntimeError(
                "AGENT_SERVER_FILES_BACKEND=s3 requires httpx-s3-client. "
                "Install it with: uv add git+https://gitlab.t4wefan.pub/t4wefan/httpx-s3-client.git"
            ) from exc

        self._bucket = bucket
        self._prefix = prefix.strip("/")
        config = S3Config(
            access_key=access_key,
            secret_key=secret_key,
            region=region,
            endpoint_url=endpoint_url,
            virtual_host_style=virtual_host_style,
        )
        self._client = AsyncS3Client(config)

    async def write(
        self,
        session_id: str,
        file_id: str,
        data: bytes,
        metadata: dict[str, Any],
    ) -> None:
        await self._client.put_object(
            self._bucket,
            self._blob_key(session_id, file_id),
            data,
            content_type=metadata.get("mediaType") or "application/octet-stream",
        )
        await self._client.put_object(
            self._bucket,
            self._metadata_key(session_id, file_id),
            json.dumps(metadata, ensure_ascii=False, indent=2).encode("utf-8"),
            content_type="application/json",
        )

    async def read(
        self, session_id: str, file_id: str
    ) -> tuple[bytes, dict[str, Any]]:
        metadata = await self.metadata(session_id, file_id)
        try:
            data = await self._client.get_object(
                self._bucket,
                self._blob_key(session_id, file_id),
            )
        except Exception as exc:
            if exc.__class__.__name__ == "S3ObjectNotFoundError":
                raise KeyError(file_id) from exc
            raise
        return data, metadata

    async def delete(self, session_id: str, file_id: str) -> None:
        for key in (self._blob_key(session_id, file_id), self._metadata_key(session_id, file_id)):
            try:
                await self._client.delete_object(self._bucket, key)
            except Exception as exc:
                if exc.__class__.__name__ != "S3ObjectNotFoundError":
                    raise

    async def exists(self, session_id: str, file_id: str) -> bool:
        try:
            await self._client.head_object(self._bucket, self._blob_key(session_id, file_id))
            await self._client.head_object(self._bucket, self._metadata_key(session_id, file_id))
            return True
        except Exception as exc:
            if exc.__class__.__name__ == "S3ObjectNotFoundError":
                return False
            raise

    async def metadata(self, session_id: str, file_id: str) -> dict[str, Any]:
        try:
            raw = await self._client.get_object(
                self._bucket,
                self._metadata_key(session_id, file_id),
            )
        except Exception as exc:
            if exc.__class__.__name__ == "S3ObjectNotFoundError":
                raise KeyError(file_id) from exc
            raise
        return json.loads(raw.decode("utf-8"))

    async def open_url(
        self,
        session_id: str,
        file_id: str,
        *,
        expires_in: int,
    ) -> FileOpenUrl | None:
        return FileOpenUrl(
            self._client.generate_presigned_url(
                "GET",
                self._bucket,
                self._blob_key(session_id, file_id),
                expires_in=expires_in,
            )
        )

    def _blob_key(self, session_id: str, file_id: str) -> str:
        return self._key(session_id, f"{file_id}.bin")

    def _metadata_key(self, session_id: str, file_id: str) -> str:
        return self._key(session_id, f"{file_id}.json")

    def _key(self, session_id: str, leaf: str) -> str:
        path = f"{session_id}/{leaf}"
        return f"{self._prefix}/{path}" if self._prefix else path
