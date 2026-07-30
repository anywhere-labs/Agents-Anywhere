from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from agent_server.core.interactions import (
    InteractionDomainError,
    InteractionResponseCommand,
    prepare_interaction_response,
    require_interaction_transition,
    require_new_interaction,
)
from agent_server.core.models import (
    Approval,
    ApprovalIn,
    Notice,
    NoticeIn,
    NoticeStatus,
    RpcResponsePayload,
)
from agent_server.services.approvals import (
    ApprovalConflictError,
    ApprovalExpiredError,
    ApprovalNotFoundError,
    ApprovalService,
    ApprovalServiceError,
    ApprovalUpstreamError,
)
from agent_server.services.notices import approval_interaction_notice
from agent_server.services.repository_ports import (
    InteractionProjectionRepository,
    InteractionRepository,
)
from agent_server.services.session_states import SessionStateService

InteractionErrorKind = Literal["not_found", "conflict", "invalid", "upstream"]


class InteractionServiceError(RuntimeError):
    def __init__(
        self,
        kind: InteractionErrorKind,
        detail: str,
        *,
        target_status: NoticeStatus | None = None,
        context_patch: dict[str, Any] | None = None,
        changed: bool = False,
    ) -> None:
        super().__init__(detail)
        self.kind = kind
        self.detail = detail
        self.target_status = target_status
        self.context_patch = dict(context_patch or {})
        self.changed = changed


@dataclass(frozen=True)
class InteractionResolution:
    response: RpcResponsePayload
    context_patch: dict[str, Any]


class ApprovalInteractionPort(Protocol):
    async def respond(
        self,
        command: InteractionResponseCommand,
        *,
        user_id: str,
    ) -> InteractionResolution: ...


class ApprovalInteractionResolver:
    def __init__(self, approvals: ApprovalService) -> None:
        self._approvals = approvals

    async def respond(
        self,
        command: InteractionResponseCommand,
        *,
        user_id: str,
    ) -> InteractionResolution:
        approval_id = command.context.get("approvalId")
        if not isinstance(approval_id, str):
            raise InteractionServiceError(
                "invalid",
                "interaction is missing approval id",
                target_status="failed",
            )
        approval_status = _approval_status_for_action(command.action_id)
        if approval_status is None:
            raise InteractionServiceError(
                "invalid",
                "invalid approval action",
                target_status="failed",
            )
        try:
            response = await self._approvals.resolve(
                approval_id,
                approval_status,
                user_id=user_id,
            )
            return InteractionResolution(
                response=response,
                context_patch={"approvalStatus": approval_status},
            )
        except ApprovalExpiredError as exc:
            raise InteractionServiceError(
                "conflict",
                exc.detail,
                target_status="expired",
                context_patch={
                    "approvalStatus": "expired",
                    "closedReason": "runtime_no_longer_accepts_response",
                },
            ) from exc
        except ApprovalNotFoundError as exc:
            raise InteractionServiceError(
                "not_found",
                exc.detail,
                target_status="failed",
            ) from exc
        except ApprovalConflictError as exc:
            raise InteractionServiceError(
                "conflict",
                exc.detail,
                target_status="failed",
            ) from exc
        except ApprovalUpstreamError as exc:
            raise InteractionServiceError(
                "upstream",
                exc.detail,
                target_status="failed",
            ) from exc
        except ApprovalServiceError as exc:
            raise InteractionServiceError(
                "upstream",
                exc.detail,
                target_status="failed",
            ) from exc


class InteractionService:
    def __init__(
        self,
        store: InteractionRepository,
        approval_resolver: ApprovalInteractionPort,
    ) -> None:
        self._store = store
        self._approval_resolver = approval_resolver
        self._session_states = SessionStateService(store)

    async def respond(
        self,
        session_id: str,
        interaction_id: str,
        *,
        action_id: str,
        input_data: dict[str, Any] | None,
        user_id: str,
    ) -> RpcResponsePayload:
        try:
            await self._store.get_session(session_id, user_id=user_id)
            interaction = await self._store.get_notice(interaction_id)
        except KeyError:
            raise InteractionServiceError(
                "not_found", "interaction not found"
            ) from None
        try:
            command = prepare_interaction_response(
                interaction,
                session_id=session_id,
                action_id=action_id,
                input_data=input_data,
            )
        except InteractionDomainError as exc:
            kind: InteractionErrorKind = (
                "conflict" if exc.code == "not_open" else "invalid"
            )
            if exc.code in {"not_interaction", "wrong_session"}:
                kind = "not_found"
            raise InteractionServiceError(kind, exc.detail) from exc

        interaction = await self._transition(
            interaction,
            "response_accepted",
            context_patch={
                "response": {
                    "actionId": command.action_id,
                    "input": command.input,
                }
            },
        )
        interaction = await self._transition(
            interaction,
            "resolving",
            changed_on_conflict=True,
        )
        try:
            resolution = await self._resolve(command, user_id=user_id)
        except InteractionServiceError as exc:
            target_status = exc.target_status or "failed"
            await self._transition(
                interaction,
                target_status,
                context_patch={"error": exc.detail, **exc.context_patch},
                changed_on_conflict=True,
            )
            await self._session_states.reconcile(session_id)
            raise InteractionServiceError(
                exc.kind,
                exc.detail,
                target_status=target_status,
                changed=True,
            ) from exc
        await self._transition(
            interaction,
            "resolved",
            context_patch=resolution.context_patch,
            changed_on_conflict=True,
        )
        await self._session_states.reconcile(session_id)
        return resolution.response

    async def _resolve(
        self,
        command: InteractionResponseCommand,
        *,
        user_id: str,
    ) -> InteractionResolution:
        if command.interaction_type == "approval":
            return await self._approval_resolver.respond(command, user_id=user_id)
        return InteractionResolution(
            response=RpcResponsePayload(ok=True, result={"resolved": True}),
            context_patch={},
        )

    async def _transition(
        self,
        interaction: Notice,
        target: NoticeStatus,
        *,
        context_patch: dict[str, Any] | None = None,
        changed_on_conflict: bool = False,
    ) -> Notice:
        require_interaction_transition(interaction, target)
        try:
            return await self._store.update_notice_status(
                interaction.noticeId,
                target,
                expected_status=interaction.status,
                context_patch=context_patch,
            )
        except ValueError as exc:
            raise InteractionServiceError(
                "conflict",
                "interaction state changed",
                changed=changed_on_conflict,
            ) from exc


@dataclass(frozen=True)
class ApprovalInteractionProjection:
    approval: Approval
    interaction: Notice


class InteractionProjectionService:
    def __init__(self, store: InteractionProjectionRepository) -> None:
        self._store = store
        self._session_states = SessionStateService(store)

    async def project_approval(
        self,
        approval: ApprovalIn,
        *,
        session_id: str,
    ) -> ApprovalInteractionProjection:
        normalized = approval
        if approval.sessionId != session_id:
            normalized = ApprovalIn.model_validate(
                {**approval.model_dump(), "sessionId": session_id}
            )
        stored_approval = await self._store.upsert_approval(normalized)
        interaction = await self.project_interaction(
            approval_interaction_notice(stored_approval)
        )
        return ApprovalInteractionProjection(
            approval=stored_approval,
            interaction=interaction,
        )

    async def project_interaction(self, interaction: NoticeIn) -> Notice:
        require_new_interaction(interaction)
        stored = await self._store.upsert_notice(interaction)
        await self._session_states.reconcile(stored.sessionId)
        return stored


def _approval_status_for_action(action_id: str) -> str | None:
    return {
        "approve": "approved",
        "approve_for_session": "approved_for_session",
        "reject": "rejected",
        "cancel": "cancelled",
    }.get(action_id)
