from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeOperationResult,
    RuntimeSessionStateCache,
    RuntimeUnsupportedError,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain.approvals import approval_response_from_interaction
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.sdk.runtime_client import CodexRuntimeClient

EnsureStarted = Callable[[], Awaitable[None]]


@dataclass(slots=True)
class CodexInteractionController:
    host: RuntimeHostClient
    client: CodexRuntimeClient | None
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    notices: CodexNoticeRegistry
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
        action_or_status = status if isinstance(status, str) else action_id
        notice_context = self.notice_context_for_response(notice_id)
        response_context = interaction_response_context(notice_context, data)
        response = approval_response_from_interaction(
            action_or_status,
            response_context,
        )
        await self.ensure_started()
        await self._notice_responding(
            notice_id=notice_id,
            action_id=action_id,
            decision=response.decision,
        )
        try:
            await self.client.respond(request_id, response.payload)
        except Exception as exc:
            await self._notice_response_failed(
                session_id=session_id,
                notice_id=notice_id,
                action_id=action_id,
                decision=response.decision,
                exc=exc,
            )
            raise
        await self._notice_resolved(
            notice_id=notice_id,
            action_id=action_id,
            decision=response.decision,
            response_payload=response.payload,
        )
        cached_state = self.session_states.get(session_id)
        if cached_state is not None:
            next_status = (
                "blocked"
                if self.notices.open_blocking_for_session(session_id)
                else "running"
                if self.active_turn_ids.get(session_id) is not None
                else "idle"
            )
            await self.session_states.update(
                session_id=session_id,
                external_session_id=cached_state.external_session_id,
                status=next_status,
                metadata={
                    "source": "codex.approval/responded",
                    "notice_id": notice_id,
                    "decision": response.decision,
                },
            )
        return RuntimeOperationResult(
            ok=True,
            result={
                "resolved": True,
                "noticeId": notice_id,
                "sessionId": session_id,
                "decision": response.decision,
                "response": response.payload,
            },
        )

    def notice_context_for_response(self, notice_id: str) -> Mapping[str, Any]:
        notice = self.notices.get(notice_id)
        if notice is None:
            return {}
        return notice.context

    async def _notice_responding(
        self,
        notice_id: str,
        action_id: str,
        decision: str,
    ) -> None:
        notice = self.notices.transition(
            notice_id,
            status="responding",
            context={
                "approvalStatus": "responding",
                "responseActionId": action_id,
                "decision": decision,
            },
            metadata={"source": "codex.approval/responding"},
        )
        if notice is not None:
            await self.host.notice_upsert(notice)

    async def _notice_resolved(
        self,
        notice_id: str,
        action_id: str,
        decision: str,
        response_payload: Mapping[str, Any],
    ) -> None:
        notice = self.notices.transition(
            notice_id,
            status="resolved",
            response_required=False,
            blocking=None,
            actions=(),
            context={
                "approvalStatus": "resolved",
                "responseActionId": action_id,
                "decision": decision,
                "responsePayload": response_payload,
            },
            metadata={"source": "codex.approval/responded"},
        )
        if notice is not None:
            await self.host.notice_upsert(notice)

    async def _notice_response_failed(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        decision: str,
        exc: Exception,
    ) -> None:
        notice = self.notices.transition(
            notice_id,
            status="open",
            response_required=True,
            context={
                "approvalStatus": "pending",
                "responseActionId": action_id,
                "decision": decision,
            },
            metadata={
                "source": "codex.approval/respond_failed",
                "error": {
                    "code": exc.__class__.__name__,
                    "message": str(exc) or exc.__class__.__name__,
                },
                "retryable": True,
            },
        )
        if notice is not None:
            await self.host.notice_upsert(notice)
        cached_state = self.session_states.get(session_id)
        if cached_state is not None:
            await self.session_states.update(
                session_id=session_id,
                external_session_id=cached_state.external_session_id,
                status="blocked",
                metadata={
                    "source": "codex.approval/respond_failed",
                    "notice_id": notice_id,
                },
            )


def interaction_response_context(
    notice_context: Mapping[str, Any],
    input_data: Mapping[str, Any],
) -> Mapping[str, Any]:
    notice_approval_source = notice_context.get("approvalSource")
    input_approval_source = input_data.get("approvalSource")
    if isinstance(notice_approval_source, Mapping) and isinstance(
        input_approval_source,
        Mapping,
    ):
        approval_source = {**notice_approval_source, **input_approval_source}
        return {
            **notice_context,
            **input_data,
            "approvalSource": approval_source,
        }
    return {**notice_context, **input_data}
