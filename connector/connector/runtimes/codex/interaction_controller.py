from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeOperationResult,
    RuntimeSessionStateCache,
    RuntimeUnsupportedError,
)
from connector.runtimes.codex.approvals import approval_decision
from connector.runtimes.codex.runtime_client import CodexRuntimeClient

EnsureStarted = Callable[[], Awaitable[None]]


@dataclass(slots=True)
class CodexInteractionController:
    client: CodexRuntimeClient | None
    session_states: RuntimeSessionStateCache
    ensure_started: EnsureStarted

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        if self.client is None:
            raise RuntimeUnsupportedError("respond_interaction")
        data = dict(input_data or {})
        request_id = data.get("requestId")
        if not isinstance(request_id, str | int):
            approval_source = data.get("approvalSource")
            if isinstance(approval_source, dict):
                request_id = approval_source.get("requestId")
        if not isinstance(request_id, str | int):
            raise TypeError("requestId is required to respond to a Codex interaction")
        status = data.get("approvalStatus")
        decision = approval_decision(status if isinstance(status, str) else action_id)
        await self.ensure_started()
        await self.client.respond(request_id, {"decision": decision})
        cached_state = self.session_states.get(session_id)
        if cached_state is not None:
            await self.session_states.update(
                session_id=session_id,
                external_session_id=cached_state.external_session_id,
                status="running",
                metadata={
                    "source": "codex.approval/responded",
                    "notice_id": notice_id,
                    "decision": decision,
                },
            )
        return RuntimeOperationResult(
            ok=True,
            result={
                "resolved": True,
                "noticeId": notice_id,
                "sessionId": session_id,
                "decision": decision,
            },
        )
