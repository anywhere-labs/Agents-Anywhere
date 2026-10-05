from __future__ import annotations

from dataclasses import replace

from connector.logging import logger
from connector.runtime_protocol import RuntimeAttachment, SessionNotice
from connector.runtime_protocol.attachments import attachment_target
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.sdk.runtime_client import CodexTurnInputAttachment


async def materialize_codex_attachments(
    host: RuntimeHostClient,
    session_id: str,
    attachments: tuple[RuntimeAttachment, ...],
    notices: CodexNoticeRegistry,
) -> tuple[CodexTurnInputAttachment, ...]:
    """Materialize user attachments to local files for Codex SDK input.

    Side effects:
    - downloads each attachment through the runtime host
    - writes each attachment into the connector-local attachment directory
    """

    materialized: list[CodexTurnInputAttachment] = []
    failed: list[RuntimeAttachment] = []
    for attachment in attachments:
        try:
            downloaded = await host.attachment_download(session_id, attachment.file_id)
        except Exception:  # noqa: BLE001
            logger.exception(
                "Codex attachment download failed file_id={}", attachment.file_id
            )
            failed.append(attachment)
            continue
        name = downloaded.name or attachment.name or attachment.file_id
        target = attachment_target(session_id, attachment.file_id, name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(downloaded.content)
        materialized.append(
            CodexTurnInputAttachment(
                name=name,
                path=str(target),
                media_type=downloaded.media_type
                or attachment.media_type
                or "application/octet-stream",
                byte_size=len(downloaded.content),
            )
        )
    notice_id = f"notice_codex_attachment_delivery_{session_id}"
    if failed:
        names = "\n".join(f"- {item.name or item.file_id}" for item in failed)
        notice = SessionNotice(
            notice_id=notice_id,
            session_id=session_id,
            runtime="codex",
            type="notification",
            title="Attachments were not delivered",
            message=(
                "AA could not download these attachments:\n"
                f"{names}\n"
                "The message continues with the remaining attachments. "
                "Codex did not receive the files listed above. Please resend them."
            ),
            severity="warning",
            context={"failedFileIds": [item.file_id for item in failed]},
        )
        notices.upsert(notice)
        await host.notice_upsert(notice)
    elif attachments:
        previous = notices.get(notice_id)
        if previous is not None and previous.status == "open":
            notice = replace(previous, status="resolved")
            notices.upsert(notice)
            await host.notice_upsert(notice)
    return tuple(materialized)
