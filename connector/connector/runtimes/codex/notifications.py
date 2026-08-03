from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import RuntimeSessionStateCache, SessionNotice
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex import sessions as codex_sessions
from connector.runtimes.codex.approvals import (
    approval_notice_from_request,
    is_approval_request,
)
from connector.runtimes.codex.notice_registry import CodexNoticeRegistry
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.sdk.runtime_client import CodexNotificationMessage
from connector.runtimes.codex.timeline_accumulator import CodexTimelineAccumulator


@dataclass(slots=True)
class CodexNotificationProjector:
    """Project native Codex notifications into runtime protocol host updates."""

    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    timeline: CodexTimelineAccumulator
    notices: CodexNoticeRegistry

    async def handle(self, message: CodexNotificationMessage) -> None:
        event = (
            message
            if isinstance(message, CodexSdkEvent)
            else CodexSdkEvent.from_message(message)
        )
        params = event.params
        thread_id = event.thread_id or codex_sessions.thread_id_from_result(params)
        session_id = (
            event.platform_session_id
            or codex_sessions.session_id_from_notification(params)
        )
        if session_id is None and thread_id is not None:
            session_id = codex_sessions.stable_session_id(
                self.host.connector_id, thread_id
            )
        if session_id is None or thread_id is None:
            return
        if is_approval_request(event.event_type):
            await self._handle_approval_request(
                session_id=session_id,
                thread_id=thread_id,
                method=event.event_type,
                params=params,
                request_id=event.request_id,
            )
            return
        if event.is_turn_started:
            await self._handle_turn_started(session_id, thread_id, params)
        elif event.is_terminal_turn:
            await self._handle_turn_completed(
                session_id,
                thread_id,
                params,
                method=event.event_type,
            )
        elif event.is_failed_turn:
            await self._handle_turn_failed(session_id, thread_id, params)
        item = self.timeline.item_from_event(
            session_id=session_id,
            external_session_id=thread_id,
            event=event,
        )
        if item is not None:
            await self._handle_item_activity(session_id, thread_id, event)
            await self.host.timeline_item_upsert(item)

    async def _handle_approval_request(
        self,
        session_id: str,
        thread_id: str,
        method: str,
        params: dict[str, Any],
        request_id: Any,
    ) -> None:
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
        await self.host.notice_upsert(notice)
        await self._set_session_state(
            session_id=session_id,
            external_session_id=thread_id,
            status="blocked",
            metadata={
                "source": method,
                "notice_id": notice.notice_id,
                **({"turn_id": turn_id} if turn_id else {}),
            },
        )

    async def _handle_turn_started(
        self,
        session_id: str,
        thread_id: str,
        params: dict[str, Any],
    ) -> None:
        turn_id = codex_sessions.turn_id_from_result(params)
        if turn_id is not None:
            self.active_turn_ids[session_id] = turn_id
        await self._set_session_state(
            session_id=session_id,
            external_session_id=thread_id,
            status="running",
            metadata={
                "source": "codex.turn/started",
                **({"turn_id": turn_id} if turn_id else {}),
            },
        )

    async def _handle_turn_completed(
        self,
        session_id: str,
        thread_id: str,
        params: dict[str, Any],
        method: str = "turn/completed",
    ) -> None:
        self.active_turn_ids.pop(session_id, None)
        turn_items = self.timeline.items_from_turn_notification(
            session_id=session_id,
            external_session_id=thread_id,
            params=params,
            method=method,
        )
        if turn_items:
            await self.host.timeline_sync(
                session_id=session_id,
                runtime="codex",
                external_session_id=thread_id,
                items=turn_items,
                complete=False,
                metadata={"source": f"codex.{method}"},
            )
        await self._close_blocking_notices_for_terminal_turn(
            session_id=session_id,
            status="closed",
            reason=method.rsplit("/", maxsplit=1)[-1],
            source=f"codex.{method}",
        )
        await self._set_session_state(
            session_id=session_id,
            external_session_id=thread_id,
            status="idle",
            metadata={"source": f"codex.{method}"},
        )

    async def _handle_turn_failed(
        self,
        session_id: str,
        thread_id: str,
        params: dict[str, Any],
    ) -> None:
        turn_id = codex_sessions.turn_id_from_result(
            params
        ) or self.active_turn_ids.get(session_id)
        self.active_turn_ids.pop(session_id, None)
        turn_items = self.timeline.items_from_turn_notification(
            session_id=session_id,
            external_session_id=thread_id,
            params=params,
            method="turn/failed",
        )
        if turn_items:
            await self.host.timeline_sync(
                session_id=session_id,
                runtime="codex",
                external_session_id=thread_id,
                items=turn_items,
                complete=False,
                metadata={"source": "codex.turn/failed"},
            )
        notice = self._execution_error_notice(
            session_id=session_id,
            thread_id=thread_id,
            turn_id=turn_id,
            params=params,
        )
        await self._close_blocking_notices_for_terminal_turn(
            session_id=session_id,
            status="closed",
            reason="failed",
            source="codex.turn/failed",
        )
        self.notices.upsert(notice)
        await self.host.notice_upsert(notice)
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread_id,
            status="blocked",
            error=_error_from_params(params),
            metadata={
                "source": "codex.turn/failed",
                "notice_id": notice.notice_id,
                **({"turn_id": turn_id} if turn_id else {}),
            },
        )

    async def _handle_item_activity(
        self,
        session_id: str,
        thread_id: str,
        event: CodexSdkEvent,
    ) -> None:
        turn_id = event.turn_id or self.active_turn_ids.get(session_id)
        if turn_id is not None:
            self.active_turn_ids[session_id] = turn_id
        cached = self.session_states.get(session_id)
        if cached is not None and cached.status == "blocked":
            return
        if event.is_running_item_event:
            await self._set_session_state(
                session_id=session_id,
                external_session_id=thread_id,
                status="running",
                metadata={
                    "source": f"codex.{event.event_type}",
                    **({"turn_id": turn_id} if turn_id else {}),
                },
            )

    def _execution_error_notice(
        self,
        session_id: str,
        thread_id: str,
        turn_id: str | None,
        params: dict[str, Any],
    ) -> SessionNotice:
        error = _error_from_params(params)
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

    async def _close_blocking_notices_for_terminal_turn(
        self,
        session_id: str,
        status: str,
        reason: str,
        source: str,
    ) -> None:
        for notice in self.notices.close_open_for_session(
            session_id=session_id,
            status=status,
            reason=reason,
            source=source,
        ):
            await self.host.notice_upsert(notice)

    async def _set_session_state(
        self,
        session_id: str,
        external_session_id: str | None,
        status: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        await self.session_states.update(
            session_id=session_id,
            external_session_id=external_session_id,
            status=status,  # type: ignore[arg-type]
            metadata=metadata,
        )


def _error_from_params(params: dict[str, Any]) -> dict[str, Any]:
    raw = params.get("error")
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
