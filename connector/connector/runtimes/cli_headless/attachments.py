from __future__ import annotations

from dataclasses import dataclass

from connector.logging import logger
from connector.runtime_protocol import RuntimeAttachment
from connector.runtime_protocol.attachments import attachment_target
from connector.runtime_protocol.host import RuntimeHostClient


@dataclass(frozen=True, slots=True)
class HeadlessTurnAttachment:
    """One attachment materialized next to the workspace for a headless CLI."""

    name: str
    path: str
    media_type: str
    byte_size: int
    file_id: str


async def materialize_headless_attachments(
    host: RuntimeHostClient,
    session_id: str,
    attachments: tuple[RuntimeAttachment, ...],
) -> tuple[HeadlessTurnAttachment, ...]:
    """Download attachments to the connector attachment directory.

    Mirrors the Claude runtime staging contract: each file is written under
    the session attachment target so CLI kernels can read it from disk.
    """
    materialized: list[HeadlessTurnAttachment] = []
    for attachment in attachments:
        try:
            downloaded = await host.attachment_download(session_id, attachment.file_id)
        except Exception:  # noqa: BLE001
            logger.exception(
                "Headless attachment download failed file_id={}",
                attachment.file_id,
            )
            continue
        name = downloaded.name or attachment.name or attachment.file_id
        target = attachment_target(session_id, attachment.file_id, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(downloaded.content)
        materialized.append(
            HeadlessTurnAttachment(
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