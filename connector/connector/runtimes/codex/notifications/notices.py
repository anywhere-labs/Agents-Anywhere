from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import RuntimeSessionStateCache, SessionNotice
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.domain.approvals import approval_notice_from_request
from connector.runtimes.codex.domain.input_requests import (
    codex_input_request,
    user_input_notice,
)
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry


@dataclass(slots=True)
class CodexNoticeHandler:
    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    notices: CodexNoticeRegistry

    async def handle_approval_request(
        self,
        session_id: str,
        thread_id: str,
        method: str,
        params: dict[str, Any],
        request_id: Any,
    ) -> None:
        """Publish an approval notice and waiting-approval session state.

        Side effects:
        - binds the active turn id when the approval event carries one
        - upserts a SessionNotice through the host
        - updates SessionState.status to waiting_approval
        """

        turn_id = codex_sessions.turn_id_from_result(
            params
        ) or self.active_turn_ids.get(session_id)
        if turn_id is not None:
            self.active_turn_ids[session_id] = turn_id
        notice = approval_notice_from_request(
            session_id=session_id,
            thread_id=thread_id,
            method=method,
            params=params,
            request_id=request_id,
            turn_id=turn_id,
        )
        self.notices.upsert(notice)
        logger.info(
            "codex approval notice upsert method={} session_id={} thread_id={} turn_id={} notice_id={} request_id={} action_ids={}",
            method,
            session_id,
            thread_id,
            turn_id,
            notice.notice_id,
            request_id,
            [action.get("actionId") for action in notice.actions],
        )
        await self.host.notice_upsert(notice)
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread_id,
            status="waiting_approval",
            metadata={
                "source": method,
                "notice_id": notice.notice_id,
                **({"turn_id": turn_id} if turn_id else {}),
            },
        )

    async def handle_user_input_request(
        self,
        session_id: str,
        thread_id: str,
        method: str,
        params: dict[str, Any],
        request_id: Any,
    ) -> None:
        """Publish a `request_user_input` questionnaire for the platform form.

        Side effects:
        - binds the active turn id when the request carries one
        - upserts a SessionNotice through the host
        - updates SessionState.status to waiting for blocking requests

        Invalid questionnaires raise, so the server request is answered with an
        error instead of leaving the app-server waiting forever.
        """

        turn_id = _first_string(params, "turnId", "turn_id") or self.active_turn_ids.get(
            session_id
        )
        if turn_id is not None:
            self.active_turn_ids[session_id] = turn_id
        request = codex_input_request(params)
        is_blocking = params.get("isBlocking", True) is not False
        notice = user_input_notice(
            session_id=session_id,
            thread_id=thread_id,
            turn_id=turn_id,
            item_id=_first_string(params, "itemId", "item_id"),
            request_id=str(request_id),
            request=request,
            is_blocking=is_blocking,
        )
        self.notices.upsert(notice)
        logger.info(
            "codex input request notice upsert method={} session_id={} thread_id={} turn_id={} notice_id={} request_id={} question_count={} is_blocking={}",
            method,
            session_id,
            thread_id,
            turn_id,
            notice.notice_id,
            request_id,
            len(request.form.questions),
            is_blocking,
        )
        await self.host.notice_upsert(notice)
        if not is_blocking:
            return
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread_id,
            status="waiting",
            metadata={
                "source": method,
                "notice_id": notice.notice_id,
                **({"turn_id": turn_id} if turn_id else {}),
            },
        )

    async def close_blocking_notices_for_terminal_turn(
        self,
        session_id: str,
        status: str,
        reason: str,
        source: str,
    ) -> None:
        """Close currently open blocking notices for a terminal turn.

        Side effects:
        - mutates the Codex notice registry
        - publishes each closed notice through the host
        """

        for notice in self.notices.close_open_for_session(
            session_id=session_id,
            status=status,
            reason=reason,
            source=source,
        ):
            await self.host.notice_upsert(notice)

    def execution_error_notice(
        self,
        session_id: str,
        thread_id: str,
        turn_id: str | None,
        params: dict[str, Any],
    ) -> SessionNotice:
        error = error_from_params(params)
        code = str(error.get("code") or "codex_turn_failed")
        message = str(error.get("message") or "Codex turn failed.")
        notice_component = turn_id or code
        return SessionNotice(
            notice_id=f"notice_error_{session_id}_{notice_component}",
            session_id=session_id,
            runtime="codex",
            type="interaction",
            title="Codex turn failed",
            message=message,
            severity="error",
            status="open",
            interaction_type="execution_error",
            blocking={"scope": "session", "targetId": session_id},
            response_required=False,
            actions=(),
            source={
                "threadId": thread_id,
                **({"turnId": turn_id} if turn_id else {}),
            },
            context={
                "kind": "execution_error",
                "error": error,
                **({"turnId": turn_id} if turn_id else {}),
            },
            metadata={"source": "codex.turn/failed"},
        )

    async def publish_execution_error_notice(self, notice: SessionNotice) -> None:
        """Publish a failed-turn execution notice.

        Side effects:
        - mutates the Codex notice registry
        - upserts the notice through the host
        """

        self.notices.upsert(notice)
        await self.host.notice_upsert(notice)


def _first_string(mapping: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def error_from_params(params: dict[str, Any]) -> dict[str, Any]:
    raw = params.get("error")
    if not isinstance(raw, dict):
        turn = params.get("turn")
        if isinstance(turn, dict):
            raw = turn.get("error")
    if isinstance(raw, dict):
        code = raw.get("code")
        message = raw.get("message") or raw.get("detail")
        return {
            "code": str(code or "codex_turn_failed"),
            "message": str(message or "Codex turn failed."),
            "raw": raw,
        }
    message = params.get("message") or params.get("reason")
    return {
        "code": "codex_turn_failed",
        "message": str(message or "Codex turn failed."),
    }
