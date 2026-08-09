from __future__ import annotations

import asyncio
import secrets
from collections.abc import Mapping
from dataclasses import dataclass

from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeInvalidRequestError,
    RuntimeOperationResult,
    RuntimeSessionStateCache,
)
from connector.runtimes.claude.domain.session import ClaudeSession
from connector.runtimes.claude.notifications.projector import ClaudeNotificationProjector
from connector.runtimes.claude.sdk.client import disconnect_client, interrupt_client
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore
from connector.runtimes.claude.turns.interactions import ClaudeInteractionController
from connector.runtimes.claude.turns.lifecycle import ClaudeTurnRunner
from connector.runtimes.claude.turns.selections import ClaudeSelectionController


@dataclass(slots=True)
class ClaudeTurnActionHandler:
    session_states: RuntimeSessionStateCache
    session_store: ClaudeSessionStore
    notifications: ClaudeNotificationProjector
    selections: ClaudeSelectionController
    interactions: ClaudeInteractionController
    runner: ClaudeTurnRunner

    async def stop(self) -> None:
        tasks: list[asyncio.Task[None]] = []
        for session in self.session_store.sessions():
            if session.active_task is not None and not session.active_task.done():
                session.active_task.cancel()
                tasks.append(session.active_task)
            await disconnect_client(session.client)
            session.client = None
            session.active_turn_id = None
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        session = self._session_for(session_id, external_session_id, None)
        if self.has_active_turn(session_id):
            return RuntimeOperationResult(
                ok=False,
                code="claude_turn_already_running",
                message="Claude runtime already has an active turn for this session",
            )
        try:
            session.selections = self.selections.effective_selections(
                session_id,
                selections,
            )
        except RuntimeInvalidRequestError as exc:
            return RuntimeOperationResult(
                ok=False,
                code="claude_invalid_selection",
                message=str(exc),
            )

        turn_id = f"turn_claude_{secrets.token_urlsafe(12)}"
        session.active_turn_id = turn_id
        await self.notifications.session_state.session_state_update(
            session,
            "waiting",
            selections=session.selections,
            metadata={"source": "claude.turn.start", "turnId": turn_id},
        )
        session.active_task = asyncio.create_task(
            self.runner.drive_turn(
                session=session,
                turn_id=turn_id,
                content=content,
                attachments=attachments,
                client_message_id=client_message_id,
            )
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "turnId": turn_id,
                "externalSessionId": session.external_session_id,
            },
        )

    async def interrupt_turn(
        self,
        session_id: str,
        external_session_id: str | None = None,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        _ = external_session_id
        session = self.session_store.get(session_id)
        if session is None or session.active_turn_id is None:
            return RuntimeOperationResult(
                ok=False,
                code="claude_no_active_turn",
                message="Claude runtime has no active turn to interrupt",
            )

        interrupted = await interrupt_client(session.client)
        if session.active_task is not None and not session.active_task.done():
            session.active_task.cancel()
            interrupted = True
        turn_id = session.active_turn_id
        session.active_turn_id = None
        await self.notifications.session_state.session_state_update(
            session,
            "idle",
            metadata={
                "source": "claude.turn.interrupt",
                "turnId": turn_id,
                **({"reason": reason} if reason else {}),
            },
        )
        await self.interactions.close_open_approval_notices(
            session,
            status="closed",
            reason="interrupted",
        )
        return RuntimeOperationResult(
            ok=interrupted,
            code=None if interrupted else "claude_interrupt_unavailable",
            message=None
            if interrupted
            else "Claude SDK client did not expose interrupt",
            result={"interrupted": interrupted, "turnId": turn_id},
        )

    def has_active_turn(self, session_id: str) -> bool:
        session = self.session_store.get(session_id)
        return bool(
            session is not None
            and session.active_task is not None
            and not session.active_task.done()
        )

    def _session_for(
        self,
        session_id: str,
        external_session_id: str | None,
        cwd: str | None,
    ) -> ClaudeSession:
        return self.session_store.ensure(
            session_id=session_id,
            external_session_id=external_session_id,
            cwd=cwd,
        )
