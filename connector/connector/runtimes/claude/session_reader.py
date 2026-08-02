from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeSessionStateCache,
    RuntimeTimelineSnapshot,
    RuntimeUnsupportedError,
    SessionMeta,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude import timeline, utils

EnsureStarted = Callable[[], Awaitable[None]]
RequireSdk = Callable[[], Any]


@dataclass(slots=True)
class ClaudeSessionReader:
    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    ensure_started: EnsureStarted
    require_sdk: RequireSdk

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        _ = cursor
        _ = force
        await self.ensure_started()
        sdk = self.require_sdk()
        list_sessions = getattr(sdk, "list_sessions", None)
        if not callable(list_sessions):
            raise RuntimeUnsupportedError("list_sessions")
        sessions: list[SessionMeta] = []
        for item in list(list_sessions(limit=limit)):
            external_session_id = utils.string_attr(item, "session_id")
            if external_session_id is None:
                continue
            sessions.append(
                SessionMeta(
                    session_id=utils.stable_session_id(
                        self.host.connector_id, external_session_id
                    ),
                    external_session_id=external_session_id,
                    runtime="claude",
                    title=utils.string_attr(item, "custom_title")
                    or utils.string_attr(item, "summary"),
                    cwd=utils.string_attr(item, "cwd"),
                    ordering_time=utils.timestamp_from_ms(
                        utils.int_attr(item, "last_modified")
                    ),
                    metadata={
                        "local_state": "active",
                        "source": "claude-agent-sdk.list_sessions",
                    },
                )
            )
        return tuple(sessions[:limit])

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        cached = self.session_states.get(session_id)
        if cached is not None:
            return cached
        return SessionState(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="claude",
            status="idle",
            metadata={"source": "claude.runtime.basic"},
        )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int = 100,
    ) -> RuntimeTimelineSnapshot:
        if external_session_id is None:
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=None,
                runtime="claude",
                items=(),
                complete=True,
                metadata={"source": "claude.runtime.basic"},
            )
        await self.ensure_started()
        sdk = self.require_sdk()
        session_info = timeline.get_session_info(
            sdk, external_session_id, directory=None
        )
        messages = timeline.get_session_messages(
            sdk, external_session_id, directory=utils.string_attr(session_info, "cwd")
        )
        items = timeline.timeline_items_from_messages(
            session_id=session_id,
            external_session_id=external_session_id,
            session_info=session_info,
            messages=messages,
            limit=limit,
        )
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="claude",
            items=items,
            complete=True,
            metadata={"source": "claude-agent-sdk.history"},
        )
