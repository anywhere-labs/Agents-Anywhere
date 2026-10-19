from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping
from dataclasses import replace
from typing import Any

from connector.runtime_protocol import SessionNotice
from connector.runtimes.codex.domain.input_requests import is_input_request_context


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
        for notice in self.current_for_session(session_id):
            if notice.status not in {"open", "responding"}:
                continue
            is_questionnaire = is_input_request_context(notice.context)
            if notice.blocking is None and not is_questionnaire:
                continue
            next_notice = self.transition(
                notice.notice_id,
                status=status,
                response_required=False,
                blocking=None,
                actions=(),
                context={"inputStatus" if is_questionnaire else "approvalStatus": status},
                metadata={"source": source, "close_reason": reason},
            )
            if next_notice is not None:
                closed.append(next_notice)
        return tuple(closed)

    def close_execution_errors_for_session(
        self,
        session_id: str,
        status: str,
        reason: str,
        source: str,
    ) -> tuple[SessionNotice, ...]:
        return self._close_execution_errors(
            self.current_for_session(session_id),
            status=status,
            reason=reason,
            source=source,
        )

    def close_execution_errors_for_codex_error_info(
        self,
        codex_error_info: Collection[str],
        status: str,
        reason: str,
        source: str,
    ) -> tuple[SessionNotice, ...]:
        return self._close_execution_errors(
            (
                notice
                for notice in self._notices.values()
                if _codex_error_info(notice) in codex_error_info
            ),
            status=status,
            reason=reason,
            source=source,
        )

    def _close_execution_errors(
        self,
        notices: Iterable[SessionNotice],
        status: str,
        reason: str,
        source: str,
    ) -> tuple[SessionNotice, ...]:
        closed: list[SessionNotice] = []
        for notice in notices:
            if (
                notice.status not in {"open", "responding"}
                or notice.interaction_type != "execution_error"
            ):
                continue
            next_notice = self.transition(
                notice.notice_id,
                status=status,
                response_required=False,
                blocking=None,
                actions=(),
                metadata={"source": source, "close_reason": reason},
            )
            if next_notice is not None:
                closed.append(next_notice)
        return tuple(closed)


def _codex_error_info(notice: SessionNotice) -> str | None:
    error = notice.context.get("error")
    if not isinstance(error, Mapping):
        return None
    value = error.get("codexErrorInfo") or error.get("codex_error_info")
    if isinstance(value, str) and value:
        return value
    raw = error.get("raw")
    if not isinstance(raw, Mapping):
        return None
    value = raw.get("codexErrorInfo") or raw.get("codex_error_info")
    return value if isinstance(value, str) and value else None
