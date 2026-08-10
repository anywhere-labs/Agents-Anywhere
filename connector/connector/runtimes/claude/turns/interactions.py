from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import RuntimeOperationResult
from connector.runtimes.claude.domain.approvals import (
    ClaudeApprovalDecision,
    approval_notice,
    decision_from_action,
    notice_transition,
    permission_result_from_decision,
)
from connector.runtimes.claude.domain.session import ClaudeSession
from connector.runtimes.claude.notifications.notices import ClaudeNoticeRegistry
from connector.runtimes.claude.notifications.projector import ClaudeNotificationProjector
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore


@dataclass(slots=True)
class ClaudeInteractionController:
    session_store: ClaudeSessionStore
    notices: ClaudeNoticeRegistry
    notifications: ClaudeNotificationProjector
    has_active_turn: Callable[[str], bool]
    _approval_futures: dict[str, asyncio.Future[ClaudeApprovalDecision]] = field(
        default_factory=dict,
        init=False,
    )
    _approval_seq: int = field(default=1, init=False)

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        _ = input_data
        notice = self.notices.get(notice_id)
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
        await self.notifications.notice_handler.notice_upsert(responding)
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
        await self.notifications.notice_handler.notice_upsert(resolved)

        session = self.session_store.get(session_id)
        if session is not None:
            await self.notifications.session_state.session_state_update(
                session,
                "running" if self.has_active_turn(session_id) else "idle",
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

    def approval_callback(
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
            decision = await self.request_tool_approval(
                session=session,
                turn_id=turn_id,
                tool_name=tool_name,
                tool_input=tool_input,
                context=context,
            )
            return permission_result_from_decision(
                sdk,
                decision,
                updated_input=tool_input,
            )

        return can_use_tool

    async def request_tool_approval(
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
        self._approval_futures[notice.notice_id] = future
        await self.notifications.notice_handler.notice_upsert(notice)
        await self.notifications.session_state.session_state_update(
            session,
            "waiting_approval",
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

    async def close_open_approval_notices(
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
        for notice in self.notices.current_for_session(session.session_id):
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
            await self.notifications.notice_handler.notice_upsert(closed)

    def _next_approval_id(self, turn_id: str) -> str:
        approval_id = f"{turn_id}_{self._approval_seq}"
        self._approval_seq += 1
        return approval_id
