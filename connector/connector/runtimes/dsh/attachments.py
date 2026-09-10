from __future__ import annotations

import hashlib
import os
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any
from uuid import uuid4

from connector.runtime_protocol import RuntimeAttachment, RuntimeInvalidRequestError
from connector.runtime_protocol.host import RuntimeHostClient

@asynccontextmanager
async def staged_attachments(
    host: RuntimeHostClient,
    session_id: str,
    attachments: tuple[RuntimeAttachment, ...],
    bridge_directory: Path,
) -> AsyncIterator[list[dict[str, Any]]]:
    """Download a complete attachment batch and pass opaque local IDs across Bridge RPC.

    Both processes use the endpoint's private sibling staging directory. The
    caller keeps files alive until the request settles; failed batches never send.
    """
    seen: set[str] = set()
    for attachment in attachments:
        if not re.fullmatch(r"file_[\w-]{1,128}", attachment.file_id) or attachment.file_id in seen:
            raise RuntimeInvalidRequestError("Invalid or duplicate DSH attachment")
        seen.add(attachment.file_id)
    directory = bridge_directory / "attachments" / "staging"
    paths: list[Path] = []
    payloads: list[dict[str, Any]] = []
    try:
        if attachments:
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        for attachment in attachments:
            downloaded = await host.attachment_download(session_id, attachment.file_id)
            content = downloaded.content
            media_type = (downloaded.media_type or "").split(";", 1)[0].strip().lower()
            checksum = hashlib.sha256(content).hexdigest()
            if media_type != attachment.media_type:
                raise RuntimeInvalidRequestError("Downloaded attachment type does not match its upload")
            if attachment.size is not None and len(content) != attachment.size:
                raise RuntimeInvalidRequestError("Downloaded attachment size does not match its upload")
            if attachment.sha256 and checksum != attachment.sha256:
                raise RuntimeInvalidRequestError("Downloaded attachment content does not match its upload")
            upload_id = uuid4().hex
            path = directory / upload_id
            with path.open("xb") as file:
                paths.append(path)
                os.chmod(path, 0o600)
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            payloads.append({
                "uploadId": upload_id, "fileId": attachment.file_id,
                "name": attachment.name or downloaded.name or attachment.file_id,
                "mediaType": media_type, "size": len(content), "sha256": checksum,
            })
        yield payloads
    finally:
        for path in paths:
            with suppress(OSError):
                path.unlink(missing_ok=True)
