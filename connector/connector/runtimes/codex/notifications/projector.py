from __future__ import annotations

from dataclasses import dataclass, field

from connector.runtime_protocol import RuntimeSessionStateCache
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.domain.approvals import is_approval_request
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.notifications.notices import CodexNoticeHandler
from connector.runtimes.codex.notifications.timeline_activity import (
    CodexTimelineActivityHandler,
)
from connector.runtimes.codex.notifications.turn_lifecycle import (
    CodexTurnLifecycleHandler,
)
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.sdk.runtime_client import CodexNotificationMessage
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator


@dataclass(slots=True)
class CodexNotificationProjector:
    """Project native Codex notifications into runtime protocol host updates."""

    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    timeline: CodexTimelineAccumulator
    notices: CodexNoticeRegistry
    notice_handler: CodexNoticeHandler = field(init=False)
    turn_lifecycle: CodexTurnLifecycleHandler = field(init=False)
    timeline_activity: CodexTimelineActivityHandler = field(init=False)

    def __post_init__(self) -> None:
        self.notice_handler = CodexNoticeHandler(
            host=self.host,
            session_states=self.session_states,
            active_turn_ids=self.active_turn_ids,
            notices=self.notices,
        )
        self.turn_lifecycle = CodexTurnLifecycleHandler(
            host=self.host,
            session_states=self.session_states,
            active_turn_ids=self.active_turn_ids,
            timeline=self.timeline,
            notice_handler=self.notice_handler,
        )
        self.timeline_activity = CodexTimelineActivityHandler(
            host=self.host,
            session_states=self.session_states,
            active_turn_ids=self.active_turn_ids,
        )

    async def handle(self, message: CodexNotificationMessage) -> None:
        """Dispatch one Codex notification into state, notice, and timeline updates.

        Side effects:
        - may update SessionState through runtime state cache
        - may publish timeline items through the host
        - may publish notices through the host
        """

        event = notification_event(message)
        thread_id = event.thread_id or codex_sessions.thread_id_from_result(event.params)
        session_id = event.platform_session_id or codex_sessions.session_id_from_notification(
            event.params
        )
        if session_id is None and thread_id is not None:
            cached_state = self.session_states.get_by_external_session_id(thread_id)
            if cached_state is not None:
                session_id = cached_state.session_id
            else:
                session_id = codex_sessions.stable_session_id(
                    self.host.connector_id, thread_id
                )
        if session_id is None or thread_id is None:
            return
        if is_approval_request(event.event_type):
            await self.notice_handler.handle_approval_request(
                session_id=session_id,
                thread_id=thread_id,
                method=event.event_type,
                params=event.params,
                request_id=event.request_id,
            )
            return
        if event.is_turn_started:
            await self.turn_lifecycle.handle_turn_started(
                session_id=session_id,
                thread_id=thread_id,
                event=event,
            )
        elif event.is_terminal_turn:
            await self.turn_lifecycle.handle_turn_completed(
                session_id=session_id,
                thread_id=thread_id,
                event=event,
            )
        elif event.is_failed_turn:
            await self.turn_lifecycle.handle_turn_failed(
                session_id=session_id,
                thread_id=thread_id,
                event=event,
            )
        item = self.timeline.item_from_event(
            session_id=session_id,
            external_session_id=thread_id,
            event=event,
        )
        if item is not None:
            await self.timeline_activity.publish_item_activity(
                session_id=session_id,
                thread_id=thread_id,
                event=event,
                item=item,
            )
        if event.event_type == "thread/compacted":
            await self.session_states.update(
                session_id=session_id,
                external_session_id=thread_id,
                status="idle",
                metadata={"source": "codex.thread/compacted"},
            )


def notification_event(message: CodexNotificationMessage) -> CodexSdkEvent:
    if isinstance(message, CodexSdkEvent):
        return message
    return CodexSdkEvent.from_message(message)
