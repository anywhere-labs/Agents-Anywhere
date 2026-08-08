from __future__ import annotations

import asyncio
import secrets
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAttachment,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeSessionStateCache,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude import provider_config
from connector.runtimes.claude.domain.approvals import (
    ClaudeApprovalDecision,
    approval_notice,
    decision_from_action,
    notice_transition,
    permission_result_from_decision,
)
from connector.runtimes.claude.domain.session import ClaudeSession
from connector.runtimes.claude.sdk.client import (
    ClaudeClientFactory,
    SdkLoader,
    connect_client,
    disconnect_client,
    interrupt_client,
    load_sdk,
    new_sdk_client,
    query_client,
    receive_response_messages,
)
from connector.runtimes.claude.timeline.messages import (
    ClaudeMessageProjector,
    is_result_message,
    message_error_text,
    message_id,
    message_is_error,
    message_role,
    message_session_id,
    message_text,
)

TERMINAL_NOTICE_STATUSES = {"closed", "resolved", "cancelled", "expired"}


@dataclass(slots=True)
class ClaudeRuntime(AgentRuntime):
    config: RuntimeConfig
    host: RuntimeHostClient
    sdk_loader: SdkLoader | None = None
    client_factory: ClaudeClientFactory | None = None
    runtime_version: str = "native-0"
    _sessions: dict[str, ClaudeSession] = field(default_factory=dict, init=False)
    _session_states: RuntimeSessionStateCache = field(init=False)
    _timeline: ClaudeMessageProjector = field(init=False)
    _notices: dict[str, SessionNotice] = field(default_factory=dict, init=False)
    _approval_futures: dict[str, asyncio.Future[ClaudeApprovalDecision]] = field(
        default_factory=dict,
        init=False,
    )
    _approval_seq: int = field(default=1, init=False)

    def __post_init__(self) -> None:
        self._session_states = RuntimeSessionStateCache("claude", self.host)
        self._timeline = ClaudeMessageProjector()

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(
            runtime="claude",
            runtime_version=self.runtime_version,
            display_name="Claude",
        )

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        tasks: list[asyncio.Task[None]] = []
        for session in self._sessions.values():
            if session.active_task is not None and not session.active_task.done():
                session.active_task.cancel()
                tasks.append(session.active_task)
            await disconnect_client(session.client)
            session.client = None
            session.active_turn_id = None
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return None

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        capabilities = provider_config.claude_capabilities()
        return RuntimeCapabilitySet(
            runtime="claude",
            revision=self.config.revision,
            connector_id=self.host.connector_id,
            capabilities=tuple(
                RuntimeCapability(
                    capability_id=protocol_id,
                    scope="runtime",
                    runtime="claude",
                    connector_id=self.host.connector_id,
                    supported=supported,
                    available=supported,
                    allowed=True,
                    unavailable_reason=None
                    if supported
                    else "not_implemented",
                    metadata={"source": "claude.runtime"},
                )
                for inventory_key, protocol_id in (
                    ("modelCatalog", "catalog.model"),
                    ("modelCatalog", "catalog.effort"),
                    ("permissionCatalog", "catalog.permission"),
                    ("startTurn", "session.send_message"),
                    ("steerTurn", "session.steer"),
                    ("interruptTurn", "session.interrupt"),
                    ("interactions", "session.interaction.approval"),
                    ("attachments", "runtime.attachment"),
                )
                for supported in (capabilities.get(inventory_key) is True,)
            ),
            metadata={"source": "claude.runtime"},
        )

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        _ = query
        _ = limit
        return RuntimeModelCatalog(runtime="claude", revision=self.config.revision, models=())

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        _ = query
        _ = limit
        return RuntimePermissionCatalog(
            runtime="claude",
            revision=self.config.revision,
            permissions=(),
        )

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        state = self._session_states.get(session_id)
        if state is not None:
            return state
        if external_session_id is None:
            return None
        return self._session_states.get_by_external_session_id(external_session_id)

    async def get_session_notices(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> tuple[SessionNotice, ...]:
        _ = external_session_id
        return self._current_notices(session_id)

    async def get_session_capabilities(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> RuntimeCapabilitySet:
        _ = external_session_id
        active = self._has_active_turn(session_id)
        return RuntimeCapabilitySet(
            runtime="claude",
            revision=self.config.revision,
            session_id=session_id,
            connector_id=self.host.connector_id,
            capabilities=(
                RuntimeCapability(
                    capability_id="session.send_message",
                    scope="session",
                    runtime="claude",
                    session_id=session_id,
                    connector_id=self.host.connector_id,
                    supported=True,
                    available=not active,
                    unavailable_reason="turn_active" if active else None,
                    metadata={"source": "claude.runtime"},
                ),
                RuntimeCapability(
                    capability_id="session.interrupt",
                    scope="session",
                    runtime="claude",
                    session_id=session_id,
                    connector_id=self.host.connector_id,
                    supported=True,
                    available=active,
                    unavailable_reason=None if active else "no_active_turn",
                    metadata={"source": "claude.runtime"},
                ),
                RuntimeCapability(
                    capability_id="session.interaction.approval",
                    scope="session",
                    runtime="claude",
                    session_id=session_id,
                    connector_id=self.host.connector_id,
                    supported=True,
                    available=True,
                    metadata={"source": "claude.runtime"},
                ),
            ),
            metadata={"source": "claude.runtime"},
        )

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        _ = limit
        _ = cursor
        _ = force
        return ()

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
        _ = selections
        session = self._session_for(session_id, None, cwd)
        await self.host.session_meta_upsert(
            session_id=session_id,
            runtime="claude",
            external_session_id=session.external_session_id,
            title=title,
            cwd=cwd,
            metadata={"source": "claude.create_and_start_session"},
        )
        await self._set_session_state(
            session,
            "idle",
            metadata={"source": "claude.create_and_start_session"},
        )
        result = await self.start_turn(
            session_id=session_id,
            external_session_id=session.external_session_id,
            content=content,
            attachments=attachments,
            client_message_id=client_message_id,
        )
        return RuntimeOperationResult(
            ok=result.ok,
            code=result.code,
            message=result.message,
            result={
                "sessionId": session_id,
                "externalSessionId": session.external_session_id,
                **result.result,
            },
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        _ = selections
        if attachments:
            return RuntimeOperationResult(
                ok=False,
                code="claude_attachments_unsupported",
                message="Claude runtime attachment support is not implemented yet",
            )
        session = self._session_for(session_id, external_session_id, None)
        if session.active_task is not None and not session.active_task.done():
            return RuntimeOperationResult(
                ok=False,
                code="claude_turn_already_running",
                message="Claude runtime already has an active turn for this session",
            )

        turn_id = f"turn_claude_{secrets.token_urlsafe(12)}"
        session.active_turn_id = turn_id
        await self._set_session_state(
            session,
            "waiting",
            metadata={"source": "claude.turn.start", "turnId": turn_id},
        )
        session.active_task = asyncio.create_task(
            self._drive_turn(
                session=session,
                turn_id=turn_id,
                content=content,
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
        session = self._sessions.get(session_id)
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
        await self._set_session_state(
            session,
            "idle",
            metadata={
                "source": "claude.turn.interrupt",
                "turnId": turn_id,
                **({"reason": reason} if reason else {}),
            },
        )
        await self._close_open_approval_notices(
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

    async def _drive_turn(
        self,
        session: ClaudeSession,
        turn_id: str,
        content: str,
        client_message_id: str | None,
    ) -> None:
        try:
            sdk = load_sdk(self.sdk_loader)
            client = new_sdk_client(
                sdk=sdk,
                config_values=self.config.values,
                session=session,
                client_factory=self.client_factory,
                can_use_tool=self._approval_callback(sdk, session, turn_id),
            )
            session.client = client
            await connect_client(client)
            await self._set_session_state(
                session,
                "running",
                metadata={"source": "claude.turn.running", "turnId": turn_id},
            )
            await self.host.timeline_item_upsert(
                self._timeline.message_item(
                    session=session,
                    turn_id=turn_id,
                    role="user",
                    text=content,
                    event="claude.turn.user",
                    client_message_id=client_message_id,
                )
            )
            await query_client(client, content)

            result_error: Mapping[str, Any] | None = None
            async for message in receive_response_messages(client):
                external_session_id = message_session_id(message)
                if external_session_id is not None:
                    session.external_session_id = external_session_id
                if is_result_message(message):
                    if message_is_error(message):
                        result_error = {
                            "code": "claude_result_error",
                            "message": message_error_text(message)
                            or "Claude turn completed with an error",
                        }
                    continue
                if message_role(message) != "assistant":
                    continue
                text = message_text(message)
                if not text:
                    continue
                await self.host.timeline_item_upsert(
                    self._timeline.message_item(
                        session=session,
                        turn_id=turn_id,
                        role="assistant",
                        text=text,
                        event="claude.turn.assistant",
                        native_item_id=message_id(message),
                    )
                )

            if result_error is not None:
                await self._set_session_state(
                    session,
                    "error",
                    error=result_error,
                    metadata={"source": "claude.turn.failed", "turnId": turn_id},
                )
            else:
                await self._set_session_state(
                    session,
                    "idle",
                    metadata={"source": "claude.turn.completed", "turnId": turn_id},
                )
        except asyncio.CancelledError:
            await self._close_open_approval_notices(
                session,
                status="closed",
                reason="cancelled",
            )
            await self._set_session_state(
                session,
                "idle",
                metadata={"source": "claude.turn.cancelled", "turnId": turn_id},
            )
        except Exception as exc:  # noqa: BLE001
            await self._set_session_state(
                session,
                "error",
                error={
                    "code": exc.__class__.__name__,
                    "message": str(exc) or exc.__class__.__name__,
                },
                metadata={"source": "claude.turn.failed", "turnId": turn_id},
            )
        finally:
            await disconnect_client(session.client)
            session.client = None
            if session.active_turn_id == turn_id:
                session.active_turn_id = None

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        _ = input_data
        notice = self._notices.get(notice_id)
        if notice is None or notice.session_id != session_id:
            return RuntimeOperationResult(
                ok=False,
                code="claude_notice_not_found",
                message="Claude approval notice was not found",
            )
        future = self._approval_futures.get(notice_id)
        if future is None or future.done():
            return RuntimeOperationResult(
                ok=False,
                code="claude_notice_not_pending",
                message="Claude approval notice is not waiting for a response",
            )

        decision = decision_from_action(action_id)
        responding = notice_transition(
            notice,
            status="responding",
            decision=decision,
            metadata={"source": "claude.approval/responding"},
        )
        self._notices[notice_id] = responding
        await self.host.notice_upsert(responding)
        future.set_result(decision)

        resolved = notice_transition(
            responding,
            status="resolved",
            decision=decision,
            response_required=False,
            clear_blocking=True,
            clear_actions=True,
            metadata={"source": "claude.approval/responded"},
        )
        self._notices[notice_id] = resolved
        await self.host.notice_upsert(resolved)

        session = self._sessions.get(session_id)
        if session is not None:
            await self._set_session_state(
                session,
                "running" if self._has_active_turn(session_id) else "idle",
                metadata={
                    "source": "claude.approval/responded",
                    "notice_id": notice_id,
                    "decision": "approved" if decision.allowed else "rejected",
                },
            )
        return RuntimeOperationResult(
            ok=True,
            result={
                "resolved": True,
                "noticeId": notice_id,
                "sessionId": session_id,
                "decision": "approved" if decision.allowed else "rejected",
            },
        )

    def _approval_callback(
        self,
        sdk: Any,
        session: ClaudeSession,
        turn_id: str,
    ) -> Any:
        async def can_use_tool(
            tool_name: str,
            tool_input: dict[str, Any],
            context: Any,
        ) -> Any:
            decision = await self._request_tool_approval(
                session=session,
                turn_id=turn_id,
                tool_name=tool_name,
                tool_input=tool_input,
                context=context,
            )
            return permission_result_from_decision(sdk, decision)

        return can_use_tool

    async def _request_tool_approval(
        self,
        session: ClaudeSession,
        turn_id: str,
        tool_name: str,
        tool_input: Mapping[str, Any],
        context: Any,
    ) -> ClaudeApprovalDecision:
        notice = approval_notice(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            turn_id=turn_id,
            tool_name=tool_name,
            tool_input=tool_input,
            context=context,
            approval_id=self._next_approval_id(turn_id),
        )
        future: asyncio.Future[ClaudeApprovalDecision] = (
            asyncio.get_running_loop().create_future()
        )
        self._notices[notice.notice_id] = notice
        self._approval_futures[notice.notice_id] = future
        await self.host.notice_upsert(notice)
        await self._set_session_state(
            session,
            "blocked",
            metadata={
                "source": "claude.can_use_tool",
                "notice_id": notice.notice_id,
                "turnId": turn_id,
                "toolName": tool_name,
            },
        )
        try:
            return await future
        finally:
            self._approval_futures.pop(notice.notice_id, None)

    async def _close_open_approval_notices(
        self,
        session: ClaudeSession,
        status: str,
        reason: str,
    ) -> None:
        decision = ClaudeApprovalDecision(
            allowed=False,
            action_id="reject",
            message=f"Approval closed: {reason}",
        )
        for notice in self._current_notices(session.session_id):
            if notice.interaction_type != "approval":
                continue
            future = self._approval_futures.get(notice.notice_id)
            if future is not None and not future.done():
                future.set_result(decision)
            closed = notice_transition(
                notice,
                status=status,
                decision=decision,
                response_required=False,
                clear_blocking=True,
                clear_actions=True,
                metadata={
                    "source": "claude.approval/closed",
                    "close_reason": reason,
                },
            )
            self._notices[notice.notice_id] = closed
            await self.host.notice_upsert(closed)

    def _session_for(
        self,
        session_id: str,
        external_session_id: str | None,
        cwd: str | None,
    ) -> ClaudeSession:
        session = self._sessions.get(session_id)
        if session is None:
            session = ClaudeSession(
                session_id=session_id,
                external_session_id=external_session_id,
                cwd=cwd,
            )
            self._sessions[session_id] = session
        if external_session_id:
            session.external_session_id = external_session_id
        if cwd:
            session.cwd = cwd
        return session

    async def _set_session_state(
        self,
        session: ClaudeSession,
        status: str,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        await self._session_states.update(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            status=status,  # type: ignore[arg-type]
            error=error,
            metadata=metadata,
        )

    def _has_active_turn(self, session_id: str) -> bool:
        session = self._sessions.get(session_id)
        return bool(
            session is not None
            and session.active_task is not None
            and not session.active_task.done()
        )

    def _current_notices(self, session_id: str) -> tuple[SessionNotice, ...]:
        return tuple(
            notice
            for notice in self._notices.values()
            if notice.session_id == session_id
            and notice.status not in TERMINAL_NOTICE_STATUSES
        )

    def _next_approval_id(self, turn_id: str) -> str:
        approval_id = f"{turn_id}_{self._approval_seq}"
        self._approval_seq += 1
        return approval_id
