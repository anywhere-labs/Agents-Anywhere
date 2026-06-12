from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class FileOpenUrl:
    url: str


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

    @abstractmethod
    async def read(
        self, session_id: str, file_id: str
    ) -> tuple[bytes, dict[str, Any]]:
        """Return (data, metadata). Raise KeyError if not found."""

    @abstractmethod
    async def delete(self, session_id: str, file_id: str) -> None:
        """Remove the blob + sidecar. No-op if already gone."""

    @abstractmethod
    async def exists(self, session_id: str, file_id: str) -> bool:
        """Return True if both the blob and its sidecar are present."""

    @abstractmethod
    async def metadata(self, session_id: str, file_id: str) -> dict[str, Any]:
        """Return metadata without loading the blob. Raise KeyError if missing."""

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
