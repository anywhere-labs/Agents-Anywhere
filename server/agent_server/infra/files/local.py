from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from agent_server.infra.files.base import FileStorage


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

    async def read(
        self, session_id: str, file_id: str
    ) -> tuple[bytes, dict[str, Any]]:
        return await asyncio.to_thread(self._read, session_id, file_id)

    async def delete(self, session_id: str, file_id: str) -> None:
        await asyncio.to_thread(self._delete, session_id, file_id)

    async def exists(self, session_id: str, file_id: str) -> bool:
        return await asyncio.to_thread(self._exists, session_id, file_id)

    def _write(
        self,
        session_id: str,
        file_id: str,
        data: bytes,
        metadata: dict[str, Any],
    ) -> None:
        session_dir = self._root / session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        (session_dir / f"{file_id}.bin").write_bytes(data)
        (session_dir / f"{file_id}.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def _read(self, session_id: str, file_id: str) -> tuple[bytes, dict[str, Any]]:
        session_dir = self._root / session_id
        file_path = session_dir / f"{file_id}.bin"
        metadata_path = session_dir / f"{file_id}.json"
        if not file_path.is_file() or not metadata_path.is_file():
            raise KeyError(file_id)
        data = file_path.read_bytes()
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        return data, metadata

    def _delete(self, session_id: str, file_id: str) -> None:
        session_dir = self._root / session_id
        for suffix in (".bin", ".json"):
            target = session_dir / f"{file_id}{suffix}"
            try:
                target.unlink()
            except FileNotFoundError:
                pass

    def _exists(self, session_id: str, file_id: str) -> bool:
        session_dir = self._root / session_id
        return (session_dir / f"{file_id}.bin").is_file() and (
            session_dir / f"{file_id}.json"
        ).is_file()
