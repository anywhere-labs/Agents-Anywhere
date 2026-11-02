from __future__ import annotations

import asyncio
import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO


@dataclass(frozen=True, slots=True)
class FileOpenUrl:
    url: str


class UploadTooLarge(ValueError):
    """Raised when a streamed upload exceeds the caller's byte limit."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"upload exceeds {limit} bytes")
        self.limit = limit


class UploadEmpty(ValueError):
    """Raised when a streamed upload holds no bytes."""


class FileStorage(ABC):
    """Interface for storing uploaded file blobs and their metadata.

    Backed by local disk by default; S3-compatible storage is the planned
    alternative for cloud deployments. Implementations receive opaque
    session_id / file_id strings — validation (path-traversal checks, owner
    auth, etc.) happens in the caller before reaching this layer.
    """

    @abstractmethod
    async def write(
        self,
        session_id: str,
        file_id: str,
        data: bytes,
        metadata: dict[str, Any],
    ) -> None: ...

    async def write_stream(
        self,
        session_id: str,
        file_id: str,
        source: BinaryIO,
        metadata: dict[str, Any],
        *,
        max_bytes: int | None = None,
    ) -> dict[str, Any]:
        """Persist one blob from an open binary stream without buffering it.

        Implementations with direct disk access override this to copy in chunks
        so a 25 MB upload never materialises as one bytes object. The default
        keeps remote backends working: read the stream, hash it, store it.

        Returns the metadata dict augmented with the measured ``size`` and
        ``sha256``. Raises :class:`UploadTooLarge` / :class:`UploadEmpty`.
        """
        data = await asyncio.to_thread(_read_bounded, source, max_bytes)
        metadata = {
            **metadata,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }
        await self.write(session_id, file_id, data, metadata)
        return metadata

    @abstractmethod
    async def read(self, session_id: str, file_id: str) -> tuple[bytes, dict[str, Any]]:
        """Return (data, metadata). Raise KeyError if not found."""

    @abstractmethod
    async def delete(self, session_id: str, file_id: str) -> None:
        """Remove the blob + sidecar. No-op if already gone."""

    @abstractmethod
    async def delete_session(self, session_id: str) -> None:
        """Remove all blobs and metadata for one session. Safe to retry."""

    @staticmethod
    def _validate_session_id(session_id: str) -> None:
        if (
            not session_id
            or session_id in {".", ".."}
            or any(char in session_id for char in ("/", "\\", "\0"))
        ):
            raise ValueError("invalid file storage session id")

    @abstractmethod
    async def exists(self, session_id: str, file_id: str) -> bool:
        """Return True if both the blob and its sidecar are present."""

    @abstractmethod
    async def metadata(self, session_id: str, file_id: str) -> dict[str, Any]:
        """Return metadata without loading the blob. Raise KeyError if missing."""

    async def local_path(self, session_id: str, file_id: str) -> Path | None:
        """Return the on-disk blob path when the backend is local.

        Remote backends return None; callers then fall back to ``read``. Serving
        the file straight from disk keeps it out of memory and lets the HTTP
        layer answer range requests for resumable, parallel downloads.
        """
        return None

    async def open_url(
        self,
        session_id: str,
        file_id: str,
        *,
        expires_in: int,
    ) -> FileOpenUrl | None:
        """Return a backend-native URL, such as an S3 presigned URL.

        Local storage returns None so the API layer can redirect to its signed
        local raw route.
        """
        return None


def _read_bounded(source: BinaryIO, max_bytes: int | None) -> bytes:
    """Drain ``source`` into memory, refusing empty or oversized payloads."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if max_bytes is not None and total > max_bytes:
            raise UploadTooLarge(max_bytes)
        chunks.append(chunk)
    if total == 0:
        raise UploadEmpty()
    return b"".join(chunks)
