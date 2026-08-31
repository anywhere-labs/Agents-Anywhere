from __future__ import annotations

import asyncio
import secrets
from collections.abc import Mapping
from dataclasses import dataclass

from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeInvalidRequestError,
    RuntimeOperationResult,
    RuntimeSessionStateCache,
)
from connector.runtimes.claude.domain.session import ClaudeExecution, ClaudeSession
from connector.runtimes.claude.notifications.projector import (
    ClaudeNotificationProjector,
)
from connector.runtimes.claude.sdk.client import interrupt_client
from connector.runtimes.claude.sdk.events import interrupted_terminal_event
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
        for session in self.session_store.sessions():
            execution = session.execution
            if execution is None:
                continue
            await self.interrupt_execution(
                session=session,
                execution=execution,
                source="claude.runtime.stop",
                reason="runtime_stopped",
            )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        session = self.session_for(session_id, external_session_id, cwd)
        try:
            effective_selections = self.selections.effective_selections(
                session_id,
                selections,
            )
        except RuntimeInvalidRequestError as exc:
            return RuntimeOperationResult(
                ok=False,
                code="claude_invalid_selection",
                message=str(exc),
            )

        async with session.execution_lock:
            if session.execution is not None:
                return RuntimeOperationResult(
                    ok=False,
                    code="claude_turn_already_running",
                    message="Claude runtime already has an active turn for this session",
                )
            execution = ClaudeExecution(
                turn_id=f"turn_claude_{secrets.token_urlsafe(12)}"
            )
            session.execution = execution
            session.selections = effective_selections
            try:
                await self.notifications.session_state.session_state_update(
                    session,
                    "waiting",
                    selections=session.selections,
                    metadata={"source": "claude.turn.start"},
                )
                execution.task = asyncio.create_task(
                    self.runner.drive_turn(
                        session=session,
                        execution=execution,
                        content=content,
                        attachments=attachments,
                        client_message_id=client_message_id,
                    ),
                    name=f"claude-turn:{session.session_id}:{execution.turn_id}",
                )
                logger.info(
                    "claude_turn_task_started session_id={} turn_id={} external_session_id={} task_name={}",
                    session.session_id,
                    execution.turn_id,
                    session.external_session_id,
                    execution.task.get_name(),
                )
            except BaseException:
                session.execution = None
                execution.finished.set()
                raise
        return RuntimeOperationResult(
            ok=True,
            result={
                "turnId": execution.turn_id,
                "externalSessionId": session.external_session_id,
            },
        )

    async def interrupt_session(
        self,
        session_id: str,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        session = self.session_store.get(session_id)
        if session is None:
            return RuntimeOperationResult(
                ok=True,
                result={"interrupted": False, "alreadyStopped": True},
            )
        async with session.execution_lock:
            execution = session.execution
            if execution is None:
                return RuntimeOperationResult(
                    ok=True,
                    result={"interrupted": False, "alreadyStopped": True},
                )
            logger.warning(
                "claude_interrupt_requested session_id={} turn_id={} external_session_id={} reason={} task_name={} task_done={}",
                session.session_id,
                execution.turn_id,
                session.external_session_id,
                reason,
                execution.task.get_name() if execution.task is not None else None,
                execution.task.done() if execution.task is not None else None,
            )
            execution.interrupt_source = "claude.session.interrupt"
            execution.interrupt_reason = reason
        await self.interrupt_execution(
            session=session,
            execution=execution,
            source="claude.session.interrupt",
            reason=reason,
        )
        return RuntimeOperationResult(
            ok=True,
            result={"interrupted": True, "alreadyStopped": False},
        )

    async def interrupt_execution(
        self,
        session: ClaudeSession,
        execution: ClaudeExecution,
        source: str,
        reason: str | None,
    ) -> None:
        """Stop one owned execution and wait until all of its work has exited."""

        execution.interrupt_source = source
        execution.interrupt_reason = reason
        task = execution.task
        logger.warning(
            "claude_interrupt_execution_start session_id={} turn_id={} external_session_id={} source={} reason={} client_type={} task_name={} task_done={} task_cancelling={}",
            session.session_id,
            execution.turn_id,
            session.external_session_id,
            source,
            reason,
            execution.client.__class__.__name__ if execution.client is not None else None,
            task.get_name() if task is not None else None,
            task.done() if task is not None else None,
            task.cancelling() if task is not None else None,
        )
        try:
            sdk_interrupted = await interrupt_client(execution.client)
            logger.warning(
                "claude_sdk_interrupt_completed session_id={} turn_id={} source={} invoked={}",
                session.session_id,
                execution.turn_id,
                source,
                sdk_interrupted,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "claude_sdk_interrupt_failed session_id={} turn_id={} source={}",
                session.session_id,
                execution.turn_id,
                source,
            )
        if task is not None and not task.done():
            cancelled = task.cancel()
            logger.warning(
                "claude_turn_task_cancel_requested session_id={} turn_id={} source={} task_name={} cancel_returned={} task_cancelling={}",
                session.session_id,
                execution.turn_id,
                source,
                task.get_name(),
                cancelled,
                task.cancelling(),
            )
        if task is not None:
            await asyncio.gather(task, return_exceptions=True)
        await self.runner.finish_execution(
            session=session,
            execution=execution,
            terminal=interrupted_terminal_event(reason),
        )

    def has_active_turn(self, session_id: str) -> bool:
        session = self.session_store.get(session_id)
        return session is not None and session.execution is not None

    def session_for(
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
