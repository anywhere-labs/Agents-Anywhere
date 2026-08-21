from __future__ import annotations

from dataclasses import dataclass

from connector.runtime_protocol import RuntimeSessionStateCache
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.notifications.notices import (
    CodexNoticeHandler,
    error_from_params,
)
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator


@dataclass(slots=True)
class CodexTurnLifecycleHandler:
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    timeline: CodexTimelineAccumulator
    notice_handler: CodexNoticeHandler

    async def handle_turn_started(
        self,
        session_id: str,
        thread_id: str,
        event: CodexSdkEvent,
    ) -> None:
        """Publish running state for a started turn.

        Side effects:
        - binds the active turn id when present
        - updates SessionState.status to running
        """

        turn_id = event.turn_id or codex_sessions.turn_id_from_result(event.params)
        if turn_id is not None:
            self.active_turn_ids[session_id] = turn_id
            self.timeline.begin_turn(thread_id, turn_id)
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread_id,
            status="running",
            metadata={
                "source": "codex.turn/started",
                **({"turn_id": turn_id} if turn_id else {}),
            },
        )

    async def handle_turn_completed(
        self,
        session_id: str,
        thread_id: str,
        event: CodexSdkEvent,
    ) -> None:
        """Finish Runtime-owned turn state and publish the idle state.

        Side effects:
        - clears active_turn_ids for the session
        - releases bounded live timeline accumulation state
        - closes blocking notices
        - updates SessionState.status to idle
        """

        turn_id = (
            event.turn_id
            or codex_sessions.turn_id_from_result(event.params)
            or self.active_turn_ids.get(session_id)
        )
        self.active_turn_ids.pop(session_id, None)
        method = event.event_type
        self.timeline.end_turn(thread_id, turn_id)
        await self.notice_handler.close_blocking_notices_for_terminal_turn(
            session_id=session_id,
            status="closed",
            reason=method.rsplit("/", maxsplit=1)[-1],
            source=f"codex.{method}",
        )
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread_id,
            status="idle",
            metadata={"source": f"codex.{method}"},
        )

    async def handle_turn_failed(
        self,
        session_id: str,
        thread_id: str,
        event: CodexSdkEvent,
    ) -> None:
        """Finish Runtime-owned failed turn state and publish the error.

        Side effects:
        - clears active_turn_ids for the session
        - releases bounded live timeline accumulation state
        - closes blocking notices
        - upserts an execution error notice
        - updates SessionState.status to error
        """

        params = event.params
        turn_id = (
            event.turn_id
            or codex_sessions.turn_id_from_result(params)
            or self.active_turn_ids.get(session_id)
        )
        self.active_turn_ids.pop(session_id, None)
        self.timeline.end_turn(thread_id, turn_id)
        notice = self.notice_handler.execution_error_notice(
            session_id=session_id,
            thread_id=thread_id,
            turn_id=turn_id,
            params=params,
        )
        await self.notice_handler.close_blocking_notices_for_terminal_turn(
            session_id=session_id,
            status="closed",
            reason="failed",
            source="codex.turn/failed",
        )
        await self.notice_handler.publish_execution_error_notice(notice)
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread_id,
            status="error",
            error=error_from_params(params),
            metadata={
                "source": "codex.turn/failed",
                "notice_id": notice.notice_id,
                **({"turn_id": turn_id} if turn_id else {}),
            },
        )
