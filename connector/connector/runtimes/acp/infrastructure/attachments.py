from __future__ import annotations

import base64
import hashlib
import os
import re
from pathlib import Path

from ..domain.definitions import AcpError

IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})
MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024


async def materialize(host, session_id: str, attachments, root: Path) -> list[dict]:
    """Verify the entire batch before dispatch; files keep content-addressed native paths."""
    if len(attachments) > 16:
        raise AcpError("attachments_too_large", "每条消息最多 16 个附件。")
    seen = set()
    verified = []
    total = 0
    for attachment in attachments:
        if (
            not re.fullmatch(r"file_[\w-]{1,128}", attachment.file_id)
            or attachment.file_id in seen
        ):
            raise AcpError("invalid_attachment", "附件身份无效或重复。")
        seen.add(attachment.file_id)
        downloaded = await host.attachment_download(session_id, attachment.file_id)
        content = downloaded.content
        total += len(content)
        media_type = downloaded.media_type.split(";", 1)[0].strip().lower()
        checksum = hashlib.sha256(content).hexdigest()
        if total > MAX_ATTACHMENT_BYTES:
            raise AcpError("attachments_too_large", "附件总大小不能超过 32 MiB。")
        if (
            media_type != attachment.media_type
            or attachment.size is not None
            and len(content) != attachment.size
            or attachment.sha256
            and checksum != attachment.sha256
        ):
            raise AcpError("attachment_mismatch", "附件内容与上传记录不一致。")
        verified.append((attachment, content, media_type, checksum))
    blocks = []
    for attachment, content, media_type, checksum in verified:
        metadata = {"aa": {"attachment": {"fileId": attachment.file_id,
                    "name": attachment.name or attachment.file_id, "mediaType": media_type,
                    "size": len(content), "sha256": checksum}}}
        if media_type in IMAGE_TYPES:
            blocks.append(
                {
                    "type": "image",
                    "data": base64.b64encode(content).decode(),
                    "mimeType": media_type,
                    "_meta": metadata,
                }
            )
        else:
            directory = root / hashlib.sha256(session_id.encode()).hexdigest()
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            path = directory / checksum
            try:
                with path.open("xb") as file:
                    os.chmod(path, 0o600)
                    file.write(content)
                    file.flush()
                    os.fsync(file.fileno())
            except FileExistsError:
                if (
                    path.is_symlink()
                    or hashlib.sha256(path.read_bytes()).hexdigest() != checksum
                ):
                    raise AcpError(
                        "attachment_cache_invalid", "本机附件缓存校验失败。"
                    ) from None
            blocks.append(
                {
                    "type": "resource_link",
                    "uri": path.as_uri(),
                    "name": attachment.name or attachment.file_id,
                    "mimeType": media_type,
                    "size": len(content),
                    "_meta": metadata,
                }
            )
    return blocks
