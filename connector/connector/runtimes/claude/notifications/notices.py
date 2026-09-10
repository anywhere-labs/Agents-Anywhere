from __future__ import annotations

from dataclasses import dataclass

from connector.runtime_protocol import SessionNotice
from connector.runtime_protocol.host import RuntimeHostClient

TERMINAL_NOTICE_STATUSES = {"closed", "resolved", "cancelled", "expired"}


class ClaudeNoticeRegistry:
    def __init__(self) -> None:
        self._notices: dict[str, SessionNotice] = {}

    def get(self, notice_id: str) -> SessionNotice | None:
        return self._notices.get(notice_id)

    def upsert(self, notice: SessionNotice) -> None:
        self._notices[notice.notice_id] = notice

    def current_for_session(self, session_id: str) -> tuple[SessionNotice, ...]:
        return tuple(
            notice
            for notice in self._notices.values()
            if notice.session_id == session_id
            and notice.status not in TERMINAL_NOTICE_STATUSES
        )


@dataclass(slots=True)
class ClaudeNoticeHandler:
    host: RuntimeHostClient
    notices: ClaudeNoticeRegistry

    async def notice_upsert(self, notice: SessionNotice) -> None:
        self.notices.upsert(notice)
        await self.host.notice_upsert(notice)
