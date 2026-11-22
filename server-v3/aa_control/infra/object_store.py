from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol
from urllib.parse import quote

import httpx
from loguru import logger

from aa_control.core.config import S3ObjectStoreConfig
from aa_control.core.drive import presign_s3_url, sign_s3_request_headers
from aa_control.core.errors import UpstreamUnavailableError
from aa_control.core.models import PresignedHttpTarget


@dataclass(frozen=True)
class StoredObjectMeta:
    size_bytes: int
    etag: str | None = None
    content_type: str | None = None


class ObjectStorePort(Protocol):
    def build_object_key(self, *, user_id: str, purpose: str, file_id: str) -> str: ...

    async def presign_upload(
        self,
        *,
        object_key: str,
        size_bytes: int,
        content_type: str | None,
        expires_seconds: int,
    ) -> PresignedHttpTarget: ...

    async def presign_download(
        self,
        *,
        object_key: str,
        filename: str | None,
        content_type: str | None,
        expires_seconds: int,
    ) -> PresignedHttpTarget: ...

    async def head_object(self, object_key: str) -> StoredObjectMeta | None: ...

    async def delete_object(self, object_key: str) -> bool: ...

    async def close(self) -> None: ...


class S3ObjectStore:
    """Async S3-compatible object store using pure AWS SigV4 + httpx."""

    def __init__(
        self,
        config: S3ObjectStoreConfig,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._config = config
        self._owns_client = http_client is None
        self._http = http_client or httpx.AsyncClient(timeout=15.0)

    async def close(self) -> None:
        if self._owns_client:
            await self._http.aclose()

    def build_object_key(self, *, user_id: str, purpose: str, file_id: str) -> str:
        parts = [p for p in (self._config.key_prefix, "u", user_id, purpose, file_id) if p]
        return "/".join(parts)

    async def presign_upload(
        self,
        *,
        object_key: str,
        size_bytes: int,
        content_type: str | None,
        expires_seconds: int,
    ) -> PresignedHttpTarget:
        now = datetime.now(UTC)
        signed_headers: dict[str, str] = {"Content-Length": str(size_bytes)}
        if content_type:
            signed_headers["Content-Type"] = content_type
        url, headers = presign_s3_url(
            method="PUT",
            endpoint=self._config.presign_endpoint,
            bucket=self._config.bucket,
            object_key=object_key,
            access_key_id=self._config.access_key_id,
            secret_access_key=self._config.secret_access_key,
            region=self._config.region,
            expires_seconds=expires_seconds,
            path_style=self._config.path_style,
            signed_headers=signed_headers,
            now=now,
        )
        expires_at = (now + timedelta(seconds=expires_seconds)).isoformat().replace("+00:00", "Z")
        return PresignedHttpTarget(method="PUT", url=url, headers=headers, expires_at=expires_at)

    async def presign_download(
        self,
        *,
        object_key: str,
        filename: str | None,
        content_type: str | None,
        expires_seconds: int,
    ) -> PresignedHttpTarget:
        now = datetime.now(UTC)
        extra_query: dict[str, str] = {}
        if filename:
            ascii_fallback = "".join(ch if 32 <= ord(ch) < 127 and ch not in {'"', "\\", ";"} else "_" for ch in filename)
            encoded = quote(filename, safe="")
            extra_query["response-content-disposition"] = (
                f'attachment; filename="{ascii_fallback or "file"}"; filename*=UTF-8\'\'{encoded}'
            )
        if content_type:
            extra_query["response-content-type"] = content_type
        url, headers = presign_s3_url(
            method="GET",
            endpoint=self._config.presign_endpoint,
            bucket=self._config.bucket,
            object_key=object_key,
            access_key_id=self._config.access_key_id,
            secret_access_key=self._config.secret_access_key,
            region=self._config.region,
            expires_seconds=expires_seconds,
            path_style=self._config.path_style,
            extra_query_params=extra_query or None,
            now=now,
        )
        expires_at = (now + timedelta(seconds=expires_seconds)).isoformat().replace("+00:00", "Z")
        return PresignedHttpTarget(method="GET", url=url, headers=headers, expires_at=expires_at)

    async def head_object(self, object_key: str) -> StoredObjectMeta | None:
        url, headers = sign_s3_request_headers(
            method="HEAD",
            endpoint=self._config.endpoint,
            bucket=self._config.bucket,
            object_key=object_key,
            access_key_id=self._config.access_key_id,
            secret_access_key=self._config.secret_access_key,
            region=self._config.region,
            path_style=self._config.path_style,
        )
        try:
            resp = await self._http.head(url, headers=headers)
        except Exception as exc:  # noqa: BLE001
            raise UpstreamUnavailableError(f"object storage HEAD failed: {exc}") from exc
        if resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            raise UpstreamUnavailableError(f"object storage HEAD returned HTTP {resp.status_code}")
        raw_len = resp.headers.get("content-length")
        if raw_len is None or not raw_len.isdigit():
            raise UpstreamUnavailableError("object storage HEAD missing valid Content-Length")
        etag = resp.headers.get("etag")
        if etag is not None:
            etag = etag.strip().strip('"') or None
        return StoredObjectMeta(
            size_bytes=int(raw_len),
            etag=etag,
            content_type=resp.headers.get("content-type"),
        )

    async def delete_object(self, object_key: str) -> bool:
        url, headers = sign_s3_request_headers(
            method="DELETE",
            endpoint=self._config.endpoint,
            bucket=self._config.bucket,
            object_key=object_key,
            access_key_id=self._config.access_key_id,
            secret_access_key=self._config.secret_access_key,
            region=self._config.region,
            path_style=self._config.path_style,
        )
        try:
            resp = await self._http.delete(url, headers=headers)
        except Exception as exc:  # noqa: BLE001
            raise UpstreamUnavailableError(f"object storage DELETE failed: {exc}") from exc
        if resp.status_code in {200, 202, 204, 404}:
            return True
        raise UpstreamUnavailableError(f"object storage DELETE returned HTTP {resp.status_code}")


class DriveCleanupWorker:
    """Periodic background sweeper removing expired files and abandoned pending uploads."""

    def __init__(
        self,
        *,
        sweep_fn: Callable[[], Awaitable[int]],
        interval_seconds: float = 300.0,
    ) -> None:
        self._sweep_fn = sweep_fn
        self._interval = max(1.0, interval_seconds)

    async def run_forever(self) -> None:
        while True:
            try:
                removed = await self._sweep_fn()
                if removed:
                    logger.info("drive cleanup worker removed {} expired/abandoned files", removed)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                logger.warning("drive cleanup sweep failed: {}", exc)
            await asyncio.sleep(self._interval)
