from __future__ import annotations

import base64
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import RuntimeAttachment
from connector.runtime_protocol.attachments import attachment_target
from connector.runtime_protocol.host import RuntimeHostClient


async def materialize_claude_content(
    host: RuntimeHostClient,
    session_id: str,
    content: str,
    attachments: tuple[RuntimeAttachment, ...],
) -> Any:
    if not attachments:
        return content
    blocks: list[dict[str, Any]] = [{"type": "text", "text": content}]
    for attachment in attachments:
        try:
            downloaded = await host.attachment_download(session_id, attachment.file_id)
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "Claude attachment download failed file_id={}", attachment.file_id
            )
            blocks.append(
                {
                    "type": "text",
                    "text": f"\n\n[Failed to load attachment {attachment.file_id}: {exc}]",
                }
            )
            continue
        name = downloaded.name or attachment.name or attachment.file_id
        target = attachment_target(session_id, attachment.file_id, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(downloaded.content)
        if downloaded.media_type.startswith("image/"):
            blocks.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": downloaded.media_type,
                        "data": base64.b64encode(downloaded.content).decode("ascii"),
                    },
                }
            )
        blocks.append({"type": "text", "text": f"\n\nAttached file: {name} at {target}"})
    return blocks
