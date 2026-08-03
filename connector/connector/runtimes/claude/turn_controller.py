from __future__ import annotations

import asyncio
import secrets
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeConfig,
    RuntimeOperationResult,
    RuntimeSessionStateCache,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude import timeline
from connector.runtimes.claude.approval_controller import ClaudeApprovalController
from connector.runtimes.claude.attachments import materialize_claude_content
from connector.runtimes.claude.ordering import RuntimeOrderAllocator
from connector.runtimes.claude.runtime_session import ClaudeSession, maybe_await
from connector.runtimes.claude.turn_driver import ClaudeTurnDriver

EnsureStarted = Callable[[], Awaitable[None]]
RequireSdk = Callable[[], Any]
ClaudeClientFactory = Callable[[Any, Mapping[str, Any]], Any]


@dataclass(slots=True)
class ClaudeTurnController:
    config: RuntimeConfig
    host: RuntimeHostClient
    sessions: dict[str, ClaudeSession]
    session_states: RuntimeSessionStateCache
    ordering: RuntimeOrderAllocator
    ensure_started: EnsureStarted
    require_sdk: RequireSdk
    client_factory: ClaudeClientFactory | None = None
    approvals: ClaudeApprovalController = field(init=False)
    driver: ClaudeTurnDriver = field(init=False)

    def __post_init__(self) -> None:
        self.approvals = ClaudeApprovalController(
            host=self.host,
            sessions=self.sessions,
            session_states=self.session_states,
            require_sdk=self.require_sdk,
        )
        self.driver = ClaudeTurnDriver(
            config=self.config,
            host=self.host,
            session_states=self.session_states,
            ordering=self.ordering,
            require_sdk=self.require_sdk,
            can_use_tool=self.approvals.can_use_tool,
            client_factory=self.client_factory,
        )

    async def stop_sessions(self) -> None:
        tasks = [
            session.active_task
            for session in self.sessions.values()
            if session.active_task is not None and not session.active_task.done()
        ]
        for session in self.sessions.values():
            self.approvals.resolve_pending_approvals(session, "reject")
            client = session.client
            if client is not None:
                interrupt = getattr(client, "interrupt", None)
                if callable(interrupt):
                    await maybe_await(interrupt())
                disconnect = getattr(client, "disconnect", None)
                if callable(disconnect):
                    await maybe_await(disconnect())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.sessions.clear()

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        session = self.session_for(session_id, None, cwd)
        session.selections.update(dict(selections or {}))
        await self.host.session_meta_upsert(
            session_id=session_id,
            runtime="claude",
            external_session_id=None,
            title=title,
            cwd=cwd,
            metadata={"source": "claude.runtime.create"},
        )
        await self._set_session_state(
            session_id=session_id,
            external_session_id=None,
            status="idle",
            selections=selections,
            metadata={"source": "claude.runtime.create"},
        )
        turn_result = await self.start_turn(
            session_id=session_id,
            external_session_id=None,
            content=content,
            attachments=attachments,
            client_message_id=client_message_id,
        )
        return RuntimeOperationResult(
            ok=turn_result.ok,
            code=turn_result.code,
            message=turn_result.message,
            result={
                "sessionId": session_id,
                "externalSessionId": session.external_session_id,
                **turn_result.result,
            },
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        await self.ensure_started()
        session = self.session_for(session_id, external_session_id, None)
        if session.active_task is not None and not session.active_task.done():
            return RuntimeOperationResult(
                ok=False,
                code="claude_turn_already_running",
                message="Claude runtime already has an active turn for this session",
            )
        turn_id = f"turn_claude_{secrets.token_urlsafe(12)}"
        session.active_turn_id = turn_id
        await self._set_session_state(
            session_id=session_id,
            external_session_id=session.external_session_id,
            status="waiting",
            metadata={"source": "claude.turn/start.requested", "turn_id": turn_id},
        )
        session.active_task = asyncio.create_task(
            self.driver.drive_turn(
                session=session,
                content=content,
                attachments=attachments,
                client_message_id=client_message_id,
            )
        )
        return RuntimeOperationResult(ok=True, result={"turnId": turn_id})

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        _ = external_session_id
        session = self.sessions.get(session_id)
        if session is None or session.active_task is None or session.active_task.done():
            return RuntimeOperationResult(
                ok=False,
                code="claude_no_active_turn",
                message="Claude runtime has no active turn to steer",
            )
        client = session.client
        if client is None or not callable(getattr(client, "query", None)):
            return RuntimeOperationResult(
                ok=False,
                code="claude_steer_unavailable",
                message="Claude SDK client is not ready to receive steering input",
            )
        await client.query(
            timeline.prompt_stream(
                await materialize_claude_content(
                    self.host, session_id, content, attachments
                )
            )
        )
        await self._set_session_state(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            status="running",
            metadata={
                "source": "claude.turn/steer",
                **(
                    {"turn_id": session.active_turn_id}
                    if session.active_turn_id
                    else {}
                ),
                **({"clientMessageId": client_message_id} if client_message_id else {}),
            },
        )
        return RuntimeOperationResult(
            ok=True,
            result={"steered": True, "turnId": session.active_turn_id},
        )

    async def interrupt_turn(
        self,
        session_id: str,
        external_session_id: str | None = None,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        _ = external_session_id
        session = self.sessions.get(session_id)
        if session is None or session.active_turn_id is None:
            return RuntimeOperationResult(
                ok=False,
                code="claude_no_active_turn",
                message="Claude runtime has no active turn to interrupt",
            )
        interrupted = False
        self.approvals.resolve_pending_approvals(session, "reject")
        client = session.client
        if client is not None:
            interrupt = getattr(client, "interrupt", None)
            if callable(interrupt):
                await maybe_await(interrupt())
                interrupted = True
        if session.active_task is not None and not session.active_task.done():
            session.active_task.cancel()
            interrupted = True
        await self._set_session_state(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            status="idle",
            metadata={
                "source": "claude.turn/interrupt",
                **({"reason": reason} if reason else {}),
                **(
                    {"turn_id": session.active_turn_id}
                    if session.active_turn_id
                    else {}
                ),
            },
        )
        turn_id = session.active_turn_id
        session.active_turn_id = None
        return RuntimeOperationResult(
            ok=interrupted,
            code=None if interrupted else "claude_interrupt_unavailable",
            message=None
            if interrupted
            else "Claude SDK client did not expose interrupt",
            result={"interrupted": interrupted, "turnId": turn_id},
        )

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        return await self.approvals.respond_interaction(
            session_id=session_id,
            notice_id=notice_id,
            action_id=action_id,
            input_data=input_data,
        )

    def session_for(
        self,
        session_id: str,
        external_session_id: str | None,
        cwd: str | None,
    ) -> ClaudeSession:
        session = self.sessions.get(session_id)
        if session is None:
            session = ClaudeSession(
                session_id=session_id,
                external_session_id=external_session_id,
                cwd=cwd,
            )
            self.sessions[session_id] = session
        if external_session_id:
            session.external_session_id = external_session_id
        if cwd:
            session.cwd = cwd
        return session

    async def _set_session_state(
        self,
        session_id: str,
        external_session_id: str | None,
        status: str,
        selections: Mapping[str, str | None] | None = None,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        await self.session_states.update(
            session_id=session_id,
            external_session_id=external_session_id,
            status=status,  # type: ignore[arg-type]
            selections=selections,
            error=error,
            metadata=metadata,
        )
