from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import RuntimeSessionStateCache
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex import sessions as codex_sessions
from connector.runtimes.codex.approvals import (
    approval_notice_from_request,
    is_approval_request,
)
from connector.runtimes.codex.sdk_events import CodexSdkEvent
from connector.runtimes.codex.timeline_accumulator import CodexTimelineAccumulator


@dataclass(slots=True)
class CodexNotificationProjector:
    """Project native Codex notifications into runtime protocol host updates."""

    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    timeline: CodexTimelineAccumulator

    async def handle(self, message: dict[str, Any]) -> None:
        event = CodexSdkEvent.from_message(message)
        method = event.event_type
        params = event.params
        thread_id = event.thread_id or codex_sessions.thread_id_from_result(params)
        session_id = codex_sessions.session_id_from_notification(params)
        if session_id is None and thread_id is not None:
            session_id = codex_sessions.stable_session_id(
                self.host.connector_id, thread_id
            )
        if session_id is None or thread_id is None:
            return
        if is_approval_request(method):
            await self._handle_approval_request(
                session_id=session_id,
                thread_id=thread_id,
                method=method,
                params=params,
                request_id=event.request_id,
            )
            return
        if method == "turn/started":
            await self._handle_turn_started(session_id, thread_id, params)
        elif method in {
            "turn/completed",
            "turn/failed",
            "turn/interrupted",
            "turn/cancelled",
        }:
            await self._handle_turn_completed(
                session_id,
                thread_id,
                params,
                method=str(method),
            )
        item = self.timeline.item_from_event(
            session_id=session_id,
            external_session_id=thread_id,
            event=event,
        )
        if item is not None:
            await self.host.timeline_item_upsert(item)

    async def _handle_approval_request(
        self,
        session_id: str,
        thread_id: str,
        method: str,
        params: dict[str, Any],
        request_id: Any,
    ) -> None:
        turn_id = codex_sessions.turn_id_from_result(params) or self.active_turn_ids.get(
            session_id
        )
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
        await self._set_session_state(
            session_id=session_id,
            external_session_id=thread_id,
            status="idle",
            metadata={"source": f"codex.{method}"},
        )

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
