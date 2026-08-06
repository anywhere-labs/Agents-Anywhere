from __future__ import annotations

from connector.logging import logger
from connector.runtime_protocol import RuntimeAttachment
from connector.runtime_protocol.attachments import attachment_target
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.sdk.runtime_client import CodexTurnInputAttachment


async def materialize_codex_attachments(
    host: RuntimeHostClient,
    session_id: str,
    attachments: tuple[RuntimeAttachment, ...],
) -> tuple[CodexTurnInputAttachment, ...]:
    """Download user attachments to local files for Codex SDK input.

    Side effects:
    - downloads each attachment through the runtime host
    - writes each attachment into the connector-local attachment directory
    """

    materialized: list[CodexTurnInputAttachment] = []
    for attachment in attachments:
        try:
            downloaded = await host.attachment_download(session_id, attachment.file_id)
        except Exception:  # noqa: BLE001
            logger.exception(
                "Codex attachment download failed file_id={}", attachment.file_id
            )
            continue
        name = downloaded.name or attachment.name or attachment.file_id
        target = attachment_target(session_id, attachment.file_id, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(downloaded.content)
        materialized.append(
            CodexTurnInputAttachment(
                name=name,
                path=str(target),
                media_type=downloaded.media_type or attachment.media_type or "application/octet-stream",
            )
        )
    return tuple(materialized)
