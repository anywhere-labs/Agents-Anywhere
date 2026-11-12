from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, BinaryIO
from uuid import uuid4

from agent_server.infra.files.base import FileStorage, UploadEmpty, UploadTooLarge

_STREAM_CHUNK_BYTES = 1024 * 1024


class LocalFileStorage(FileStorage):
    """Filesystem-backed storage. Each session gets a subdirectory; each file
    is stored as a `.bin` blob plus a sidecar `.json` metadata file."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True)

    @property
    def root(self) -> Path:
        return self._root

    async def write(
        self,
        session_id: str,
        file_id: str,
        data: bytes,
        metadata: dict[str, Any],
    ) -> None:
        await asyncio.to_thread(self._write, session_id, file_id, data, metadata)

    async def read(self, session_id: str, file_id: str) -> tuple[bytes, dict[str, Any]]:
        return await asyncio.to_thread(self._read, session_id, file_id)

    async def write_stream(
        self,
        session_id: str,
        file_id: str,
        source: BinaryIO,
        metadata: dict[str, Any],
        *,
        max_bytes: int | None = None,
    ) -> dict[str, Any]:
        return await asyncio.to_thread(
            self._write_stream, session_id, file_id, source, metadata, max_bytes
        )

    async def delete(self, session_id: str, file_id: str) -> None:
        await asyncio.to_thread(self._delete, session_id, file_id)

    async def delete_session(self, session_id: str) -> None:
        self._validate_session_id(session_id)
        await asyncio.to_thread(self._delete_session, session_id)

    async def exists(self, session_id: str, file_id: str) -> bool:
        return await asyncio.to_thread(self._exists, session_id, file_id)

    async def metadata(self, session_id: str, file_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._metadata, session_id, file_id)

    async def local_path(self, session_id: str, file_id: str) -> Path | None:
        return await asyncio.to_thread(self._local_path, session_id, file_id)

    def _local_path(self, session_id: str, file_id: str) -> Path:
        self._validate_session_id(session_id)
        if (
            not file_id
            or file_id in {".", ".."}
            or any(char in file_id for char in ("/", "\\", "\0"))
        ):
            raise ValueError("invalid file id")
        blob = self._root / session_id / f"{file_id}.bin"
        if not blob.is_file():
            raise KeyError(file_id)
        return blob

    def _write(
        self,
        session_id: str,
        file_id: str,
        data: bytes,
        metadata: dict[str, Any],
    ) -> None:
        session_dir = self._root / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        # Workflow retries may write the same content-addressed ID concurrently.
        # Publish complete files so a Connector never reads a partially rewritten blob.
        temporary_blob = session_dir / f".{file_id}.{uuid4().hex}.bin"
        temporary_meta = session_dir / f".{file_id}.{uuid4().hex}.json"
        try:
            temporary_blob.write_bytes(data)
            temporary_meta.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            temporary_blob.replace(session_dir / f"{file_id}.bin")
            temporary_meta.replace(session_dir / f"{file_id}.json")
        finally:
            temporary_blob.unlink(missing_ok=True)
            temporary_meta.unlink(missing_ok=True)

    def _write_stream(
        self,
        session_id: str,
        file_id: str,
        source: BinaryIO,
        metadata: dict[str, Any],
        max_bytes: int | None,
    ) -> dict[str, Any]:
        """Copy ``source`` straight to the blob path while hashing it.

        The bytes never live in memory as one object: 1 MiB chunks are hashed,
        counted and written to a ``.part`` file that is renamed into place only
        after the whole stream landed, so a failed upload never leaves a
        half-written blob addressable by its sidecar.
        """
        self._validate_session_id(session_id)
        if (
            not file_id
            or file_id in {".", ".."}
            or any(char in file_id for char in ("/", "\\", "\0"))
        ):
            raise ValueError("invalid file id")
        session_dir = self._root / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        part_path = session_dir / f"{file_id}.bin.part"
        digest = hashlib.sha256()
        total = 0
        try:
            with part_path.open("wb") as sink:
                while True:
                    chunk = source.read(_STREAM_CHUNK_BYTES)
                    if not chunk:
                        break
                    total += len(chunk)
                    if max_bytes is not None and total > max_bytes:
                        raise UploadTooLarge(max_bytes)
                    digest.update(chunk)
                    sink.write(chunk)
            if total == 0:
                raise UploadEmpty()
            part_path.replace(session_dir / f"{file_id}.bin")
        except BaseException:
            part_path.unlink(missing_ok=True)
            raise
        stored = {
            **metadata,
            "size": total,
            "sha256": digest.hexdigest(),
        }
        temporary_meta = session_dir / f".{file_id}.{uuid4().hex}.json"
        try:
            temporary_meta.write_text(
                json.dumps(stored, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            temporary_meta.replace(session_dir / f"{file_id}.json")
        finally:
            temporary_meta.unlink(missing_ok=True)
        return stored

    def _read(self, session_id: str, file_id: str) -> tuple[bytes, dict[str, Any]]:
        metadata = self._metadata(session_id, file_id)
        session_dir = self._root / session_id
        file_path = session_dir / f"{file_id}.bin"
        if not file_path.is_file():
            raise KeyError(file_id)
        data = file_path.read_bytes()
        return data, metadata

    def _metadata(self, session_id: str, file_id: str) -> dict[str, Any]:
        session_dir = self._root / session_id
        metadata_path = session_dir / f"{file_id}.json"
        if not metadata_path.is_file():
            raise KeyError(file_id)
        return json.loads(metadata_path.read_text(encoding="utf-8"))

    def _delete(self, session_id: str, file_id: str) -> None:
        session_dir = self._root / session_id
        for suffix in (".bin", ".json"):
            target = session_dir / f"{file_id}{suffix}"
            try:
                target.unlink()
            except FileNotFoundError:
                pass
        # Derived previews live beside the blob, so drop them with it.
        for thumb in session_dir.glob(f"{file_id}.thumb-*.webp"):
            try:
                thumb.unlink()
            except FileNotFoundError:
                pass

    def _exists(self, session_id: str, file_id: str) -> bool:
        session_dir = self._root / session_id
        return (session_dir / f"{file_id}.bin").is_file() and (
            session_dir / f"{file_id}.json"
        ).is_file()

    def _delete_session(self, session_id: str) -> None:
        session_dir = self._root / session_id
        try:
            if session_dir.is_symlink():
                session_dir.unlink()
            else:
                shutil.rmtree(session_dir)
        except FileNotFoundError:
            pass
