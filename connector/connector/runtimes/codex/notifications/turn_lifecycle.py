from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field
from weakref import WeakValueDictionary

from connector.runtime_protocol import RuntimeSessionStateCache, SessionState
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.notifications.notices import (
    CodexNoticeHandler,
    error_from_params,
)
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator


@dataclass(slots=True)
class CodexTurnLifecycleHandler:
    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    timeline: CodexTimelineAccumulator
    notice_handler: CodexNoticeHandler
    _session_locks: WeakValueDictionary[str, asyncio.Lock] = field(
        default_factory=WeakValueDictionary, init=False,
    )
    _history_terminals: OrderedDict[tuple[str, str], None] = field(
        default_factory=OrderedDict, init=False,
    )

    def session_lock(self, session_id: str) -> asyncio.Lock:
        return self._session_locks.setdefault(session_id, asyncio.Lock())

    def history_reconciled(self, thread_id: str, turn_id: str | None) -> bool:
        return turn_id is not None and (thread_id, turn_id) in self._history_terminals

    async def reconcile_history_state(
        self, state: SessionState | None, expected: SessionState | None,
    ) -> SessionState | None:
        """Commit explicit terminal evidence only against the state it was read for."""
        if state is None:
            return None
        async with self.session_lock(state.session_id):
            cached = self.session_states.get(state.session_id)
            if cached is not expected:
                return cached
            if state.status != "idle" or state.metadata.get("source") != "codex.thread_history.state":
                return state
            turn_id = state.metadata.get("turn_id")
            thread_id = state.external_session_id
            if (
                cached is None or cached.status != "running"
                or state.metadata.get("native_activity_evidence") != "terminal"
                or not isinstance(turn_id, str) or not turn_id or not thread_id
                or cached.external_session_id != thread_id
                or cached.metadata.get("turn_id") != turn_id
                or self.active_turn_ids.get(state.session_id, turn_id) != turn_id
            ):
                # An unbound historical session can still be exposed read-only;
                # it must not manufacture a live cache entry or a turn end.
                return cached if cached is not None else state
            if self.history_reconciled(thread_id, turn_id):
                return cached
            native_status = str(state.metadata.get("native_status", "")).lower()
            if native_status not in {"completed", "failed", "interrupted"}:
                return cached

            # Claim and release the physical turn before the first await. A new
            # start may arrive while host publication is suspended; nothing below
            # may mutate that new turn or close its notices.
            self._history_terminals[thread_id, turn_id] = None
            while len(self._history_terminals) > 2048:
                self._history_terminals.popitem(last=False)
            self.active_turn_ids.pop(state.session_id, None)
            self.timeline.end_turn(thread_id, turn_id)
            closed = self.notice_handler.notices.close_open_for_session(
                session_id=state.session_id, status="closed", reason=native_status,
                source="codex.thread_history.reconciled",
            )
            await self.session_states.update(
                session_id=state.session_id, external_session_id=thread_id,
                status="idle", selections=state.selections, metadata=state.metadata,
            )
            for notice in closed:
                await self.host.notice_upsert(notice)
            await self.host.session_turn_ended(
                session_id=state.session_id, runtime="codex", external_session_id=thread_id,
                turn_id=turn_id, outcome=native_status,
                metadata={"source": "codex.thread_history.reconciled"},
            )
            return self.session_states.get(state.session_id)

    async def handle_turn_started(
        self,
        session_id: str,
        thread_id: str,
        event: CodexSdkEvent,
    ) -> None:
        """Publish running state for a started turn.

        Side effects:
        - binds the active turn id when present
        - closes open execution_error notices from earlier turns
        - updates SessionState.status to running
        """

        turn_id = event.turn_id or codex_sessions.turn_id_from_result(event.params)
        if self.history_reconciled(thread_id, turn_id):
            return
        if turn_id is not None:
            self.active_turn_ids[session_id] = turn_id
            self.timeline.begin_turn(thread_id, turn_id)
        await self.notice_handler.close_execution_errors_for_started_turn(session_id)
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread_id,
            status="running",
            metadata={
                "source": "codex.turn/started",
                "pendingSelectionScopes": [],
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
        if self.history_reconciled(thread_id, turn_id):
            self.timeline.end_turn(thread_id, turn_id)
            return
        if await self._finish_superseded_turn(
            session_id, thread_id, turn_id, event.event_type
        ):
            return
        self.active_turn_ids.pop(session_id, None)
        method = event.event_type
        self.timeline.end_turn(thread_id, turn_id)
        await self.notice_handler.close_blocking_notices_for_terminal_turn(
            session_id=session_id,
            status="closed",
            reason=method.rsplit("/", maxsplit=1)[-1],
            source=f"codex.{method}",
        )
        await self.host.session_turn_ended(
            session_id=session_id,
            runtime="codex",
            external_session_id=thread_id,
            turn_id=turn_id,
            outcome=method.rsplit("/", maxsplit=1)[-1],
            metadata={"source": f"codex.{method}"},
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
        if self.history_reconciled(thread_id, turn_id):
            self.timeline.end_turn(thread_id, turn_id)
            return
        if await self._finish_superseded_turn(
            session_id, thread_id, turn_id, event.event_type
        ):
            return
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
        await self.host.session_turn_ended(
            session_id=session_id,
            runtime="codex",
            external_session_id=thread_id,
            turn_id=turn_id,
            outcome="failed",
            metadata={"source": "codex.turn/failed"},
        )
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

    async def _finish_superseded_turn(
        self, session_id: str, thread_id: str, turn_id: str | None, method: str
    ) -> bool:
        # Native command turns and ordinary SDK streams can deliver independently.
        # A late terminal event belongs to its physical turn, not a newer goal turn.
        active = self.active_turn_ids.get(session_id)
        if turn_id is None or active is None or active == turn_id:
            return False
        self.timeline.end_turn(thread_id, turn_id)
        await self.host.session_turn_ended(
            session_id=session_id,
            runtime="codex",
            external_session_id=thread_id,
            turn_id=turn_id,
            outcome=method.rsplit("/", maxsplit=1)[-1],
            metadata={"source": f"codex.{method}"},
        )
        return True
