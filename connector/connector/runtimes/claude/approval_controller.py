from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeOperationResult,
    RuntimeSessionStateCache,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude import approvals, utils
from connector.runtimes.claude.runtime_session import (
    ClaudeSession,
    PendingClaudeApproval,
)

RequireSdk = Callable[[], Any]


@dataclass(slots=True)
class ClaudeApprovalController:
    host: RuntimeHostClient
    sessions: dict[str, ClaudeSession]
    session_states: RuntimeSessionStateCache
    require_sdk: RequireSdk

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        _ = input_data
        session = self.sessions.get(session_id)
        if session is None:
            return RuntimeOperationResult(
                ok=False,
                code="claude_session_not_found",
                message="Claude session is not active",
            )
        pending = session.pending_approvals.get(notice_id)
        if pending is None:
            return RuntimeOperationResult(
                ok=False,
                code="claude_interaction_not_pending",
                message="Claude interaction is not pending",
            )
        normalized_action = approvals.normalize_approval_action(action_id)
        if normalized_action is None:
            return RuntimeOperationResult(
                ok=False,
                code="claude_interaction_action_unsupported",
                message=f"Claude interaction action is not supported: {action_id}",
            )
        if not pending.future.done():
            pending.future.set_result(normalized_action)
        await self._set_session_state(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            status="running",
            metadata={
                "source": "claude.approval/responded",
                "approval_id": pending.approval_id,
                "action": normalized_action,
            },
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "noticeId": notice_id,
                "action": normalized_action,
            },
        )

    async def can_use_tool(
        self, tool_name: str, input_data: dict[str, Any], context: Any = None
    ) -> Any:
        sdk = self.require_sdk()
        context_session_id = utils.string(
            utils.extract_attr(context, "session_id", "sessionId")
        )
        session = self._session_from_context(context_session_id)
        if session is None:
            return approvals.permission_deny(sdk, "Session is not registered")
        approval_id = approvals.approval_id(
            session.session_id, session.active_turn_id, tool_name, input_data
        )
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str] = loop.create_future()
        notice = approvals.approval_notice(
            approval_id=approval_id,
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            active_turn_id=session.active_turn_id,
            tool_name=tool_name,
            input_data=input_data,
            status="open",
        )
        session.pending_approvals[approval_id] = PendingClaudeApproval(
            approval_id=approval_id,
            future=future,
            input_data=dict(input_data),
            notice=notice,
        )
        await self._set_session_state(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            status="blocked",
            metadata={
                "source": "claude.approval/requested",
                "approval_id": approval_id,
                **(
                    {"turn_id": session.active_turn_id}
                    if session.active_turn_id
                    else {}
                ),
            },
        )
        await self.host.notice_upsert(notice)
        action = await future
        session.pending_approvals.pop(approval_id, None)
        if action in {"approve", "approve_for_session"}:
            return approvals.permission_allow(sdk, input_data)
        return approvals.permission_deny(sdk, "User denied or interrupted this action")

    def resolve_pending_approvals(self, session: ClaudeSession, action: str) -> None:
        for pending in list(session.pending_approvals.values()):
            if not pending.future.done():
                pending.future.set_result(action)

    def _session_from_context(
        self, external_session_id: str | None
    ) -> ClaudeSession | None:
        if external_session_id:
            for session in self.sessions.values():
                if session.external_session_id == external_session_id:
                    return session
        for session in self.sessions.values():
            if session.active_turn_id:
                return session
        return None

    async def _set_session_state(
        self,
        session_id: str,
        external_session_id: str | None,
        status: str,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        await self.session_states.update(
            session_id=session_id,
            external_session_id=external_session_id,
            status=status,  # type: ignore[arg-type]
            metadata=metadata,
        )
