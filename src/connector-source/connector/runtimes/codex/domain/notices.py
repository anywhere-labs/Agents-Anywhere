from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import replace
from typing import Any

from connector.runtime_protocol import SessionNotice


class _Unchanged:
    pass


_UNCHANGED = _Unchanged()


class CodexNoticeRegistry:
    """Runtime-local view of Codex notices that are still lifecycle-relevant."""

    def __init__(self) -> None:
        self._notices: dict[str, SessionNotice] = {}

    def get(self, notice_id: str) -> SessionNotice | None:
        return self._notices.get(notice_id)

    def upsert(self, notice: SessionNotice) -> SessionNotice:
        self._notices[notice.notice_id] = notice
        return notice

    def open_blocking_for_session(self, session_id: str) -> tuple[SessionNotice, ...]:
        return tuple(
            notice
            for notice in self._notices.values()
            if notice.session_id == session_id
            and notice.status in {"open", "responding"}
            and notice.blocking is not None
        )

    def current_for_session(self, session_id: str) -> tuple[SessionNotice, ...]:
        terminal_statuses = {"closed", "resolved", "cancelled", "expired"}
        return tuple(
            notice
            for notice in self._notices.values()
            if notice.session_id == session_id
            and notice.status not in terminal_statuses
        )

    def transition(
        self,
        notice_id: str,
        status: str,
        response_required: bool | None = None,
        blocking: Mapping[str, Any] | None | object = _UNCHANGED,
        actions: Iterable[Mapping[str, Any]] | None | object = _UNCHANGED,
        context: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> SessionNotice | None:
        previous = self._notices.get(notice_id)
        if previous is None:
            return None
        next_notice = replace(
            previous,
            status=status,
            response_required=(
                previous.response_required
                if response_required is None
                else response_required
            ),
            blocking=previous.blocking if blocking is _UNCHANGED else blocking,
            actions=previous.actions if actions is _UNCHANGED else tuple(actions or ()),
            context={**dict(previous.context), **dict(context or {})},
            metadata={**dict(previous.metadata), **dict(metadata or {})},
        )
        self._notices[notice_id] = next_notice
        return next_notice

    def close_open_for_session(
        self,
        session_id: str,
        status: str,
        reason: str,
        source: str,
    ) -> tuple[SessionNotice, ...]:
        closed: list[SessionNotice] = []
        for notice in tuple(self.open_blocking_for_session(session_id)):
            next_notice = self.transition(
                notice.notice_id,
                status=status,
                response_required=False,
                blocking=None,
                actions=(),
                context={"approvalStatus": status},
                metadata={"source": source, "close_reason": reason},
            )
            if next_notice is not None:
                closed.append(next_notice)
        return tuple(closed)
