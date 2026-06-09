from __future__ import annotations

import hashlib
from typing import Any

from connector.local.common import (
    MAX_DIR_ENTRIES,
    MAX_READ_TEXT_BYTES,
    StaleFileError,
    UploadFile,
    encoding,
    file_upload_payload,
    nearest_existing_dir,
    required_string,
    required_text,
    resolve_path,
    workspace_root,
)


class FileOps:
    def __init__(self, upload_file: UploadFile | None = None) -> None:
        self.upload_file = upload_file

    async def read_file(self, params: dict[str, Any]) -> dict[str, Any]:
        root = workspace_root(params)
        path = resolve_path(root, required_string(params, "path"))
        if not path.is_file():
            raise FileNotFoundError(f"file not found: {path}")
        if self.upload_file is None:
            raise RuntimeError("file upload handler is not configured")
        data = path.read_bytes()
        upload = await self.upload_file(
            file_upload_payload(required_string(params, "sessionId"), path, data)
        )
        return {
            "path": str(path),
            "name": path.name,
            "size": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            **upload,
        }

    async def write_file(self, params: dict[str, Any]) -> dict[str, Any]:
        root = workspace_root(params)
        path = resolve_path(root, required_string(params, "path"))
        content_encoding = encoding(params)
        content = required_text(params, "content")
        if_match = params.get("ifMatch")
        if not path.parent.is_dir():
            raise FileNotFoundError(f"parent directory not found: {path.parent}")
        if if_match is not None:
            if not isinstance(if_match, str):
                raise ValueError("ifMatch must be a sha256 hex string")
            current_hash = ""
            if path.is_file():
                current_hash = hashlib.sha256(path.read_bytes()).hexdigest()
            elif if_match != "":
                raise StaleFileError(
                    f"file disappeared (expected sha256={if_match})"
                )
            if if_match and current_hash != if_match:
                raise StaleFileError(
                    f"file changed on disk (expected sha256={if_match}, found sha256={current_hash or 'none'})"
                )
        data = content.encode(content_encoding)
        path.write_bytes(data)
        return {
            "path": str(path),
            "encoding": "utf8",
            "bytesWritten": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        }

    async def read_text(self, params: dict[str, Any]) -> dict[str, Any]:
        root = workspace_root(params)
        path = resolve_path(root, required_string(params, "path"))
        if not path.is_file():
            raise FileNotFoundError(f"file not found: {path}")
        raw_max = params.get("maxBytes", 1_048_576)
        if not isinstance(raw_max, int):
            raise ValueError("maxBytes must be an integer")
        max_bytes = min(max(raw_max, 1), MAX_READ_TEXT_BYTES)
        full = path.read_bytes()
        clipped = full[:max_bytes]
        truncated = len(full) > max_bytes
        binary = b"\x00" in clipped
        content = "" if binary else clipped.decode("utf-8", errors="replace")
        return {
            "path": str(path),
            "name": path.name,
            "size": len(full),
            "sha256": hashlib.sha256(full).hexdigest(),
            "encoding": "utf8",
            "content": content,
            "truncated": truncated,
            "binary": binary,
        }

    async def read_dir(self, params: dict[str, Any]) -> dict[str, Any]:
        root = workspace_root(params)
        raw_path = params.get("path")
        path = root if raw_path is None else resolve_path(root, required_string(params, "path"))
        path = nearest_existing_dir(path, fallback=root)

        entries: list[dict[str, Any]] = []
        for child in sorted(path.iterdir(), key=lambda item: item.name):
            if len(entries) >= MAX_DIR_ENTRIES:
                break
            try:
                stat = child.stat()
            except OSError:
                stat = None
            entries.append(
                {
                    "name": child.name,
                    "path": str(child),
                    "type": "directory" if child.is_dir() else "file" if child.is_file() else "other",
                    "size": stat.st_size if stat is not None and child.is_file() else None,
                }
            )

        return {
            "path": str(path),
            "entries": entries,
            "truncated": len(entries) >= MAX_DIR_ENTRIES,
        }
