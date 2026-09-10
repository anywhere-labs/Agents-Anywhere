from __future__ import annotations

from dataclasses import dataclass

from connector.logging import logger
from connector.runtime_protocol import RuntimeAttachment
from connector.runtime_protocol.attachments import attachment_target
from connector.runtime_protocol.host import RuntimeHostClient


@dataclass(frozen=True, slots=True)
class ClaudeTurnAttachment:
    name: str
    path: str
    media_type: str
    byte_size: int
    file_id: str

    def to_mapping(self) -> dict[str, object]:
        return {
            "fileId": self.file_id,
            "name": self.name,
            "path": self.path,
            "mediaType": self.media_type,
            "byteSize": self.byte_size,
        }


async def materialize_claude_attachments(
    host: RuntimeHostClient,
    session_id: str,
    attachments: tuple[RuntimeAttachment, ...],
) -> tuple[ClaudeTurnAttachment, ...]:
    materialized: list[ClaudeTurnAttachment] = []
    for attachment in attachments:
        try:
            downloaded = await host.attachment_download(session_id, attachment.file_id)
        except Exception:  # noqa: BLE001
            logger.exception(
                "Claude attachment download failed file_id={}",
                attachment.file_id,
            )
            continue
        name = downloaded.name or attachment.name or attachment.file_id
        target = attachment_target(session_id, attachment.file_id, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(downloaded.content)
        materialized.append(
            ClaudeTurnAttachment(
                name=name,
                path=str(target),
                media_type=downloaded.media_type
                or attachment.media_type
                or "application/octet-stream",
                byte_size=len(downloaded.content),
                file_id=attachment.file_id,
            )
        )
    return tuple(materialized)


def content_with_attachment_notes(
    content: str,
    attachments: tuple[ClaudeTurnAttachment, ...],
) -> str:
    if not attachments:
        return content
    notes = "\n".join(
        f"- {attachment.name}: {attachment.path} ({attachment.media_type}, {attachment.byte_size} bytes)"
        for attachment in attachments
    )
    return f"{content}\n\nAttached files:\n{notes}"
