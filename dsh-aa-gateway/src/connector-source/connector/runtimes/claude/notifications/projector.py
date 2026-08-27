from __future__ import annotations

from dataclasses import dataclass, field

from connector.runtime_protocol import RuntimeSessionStateCache
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.notifications.notices import (
    ClaudeNoticeHandler,
    ClaudeNoticeRegistry,
)
from connector.runtimes.claude.notifications.session_state import (
    ClaudeSessionStateHandler,
)
from connector.runtimes.claude.notifications.timeline_activity import (
    ClaudeTimelineActivityHandler,
)
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore


@dataclass(slots=True)
class ClaudeNotificationProjector:
    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    session_store: ClaudeSessionStore
    notices: ClaudeNoticeRegistry
    notice_handler: ClaudeNoticeHandler = field(init=False)
    session_state: ClaudeSessionStateHandler = field(init=False)
    timeline_activity: ClaudeTimelineActivityHandler = field(init=False)

    def __post_init__(self) -> None:
        self.notice_handler = ClaudeNoticeHandler(
            host=self.host,
            notices=self.notices,
        )
        self.session_state = ClaudeSessionStateHandler(
            host=self.host,
            session_states=self.session_states,
        )
        self.timeline_activity = ClaudeTimelineActivityHandler(
            host=self.host,
            session_store=self.session_store,
        )
