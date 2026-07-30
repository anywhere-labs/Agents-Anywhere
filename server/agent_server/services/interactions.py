from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from loguru import logger

from agent_server.core.interactions import (
    InteractionDomainError,
    InteractionResponseCommand,
    prepare_interaction_response,
    require_interaction_transition,
    require_new_interaction,
)
from agent_server.core.models import (
    Notice,
    NoticeIn,
    NoticeStatus,
    RpcResponsePayload,
)
from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.services.repository_ports import (
    InteractionProjectionRepository,
    InteractionRepository,
    InteractionResolutionRepository,
)
from agent_server.services.session_states import SessionStateService
from agent_server.services.timeline_effects import (
    apply_approval_resolution_to_target_item,
)

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
    def __init__(
        self,
        store: InteractionResolutionRepository,
        manager: ConnectorRpcManager,
    ) -> None:
        self._store = store
        self._manager = manager

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
        approval_source = command.context.get("approvalSource")
        request_id = (
            approval_source.get("requestId")
            if isinstance(approval_source, dict)
            else None
        )
        if not isinstance(request_id, (str, int)):
            raise InteractionServiceError(
                "invalid",
                "interaction is missing approval request id",
                target_status="failed",
            )
        try:
            session = await self._store.get_session(command.session_id, user_id=user_id)
            logger.info(
                "approval interaction response requested approval_id={} status={} session_id={} connector_id={} request_id={}",
                approval_id,
                approval_status,
                session.id,
                session.connectorId,
                request_id,
            )
            result = await self._manager.request(
                session.connectorId,
                "approval.resolve",
                {
                    "approvalId": approval_id,
                    "status": approval_status,
                    "requestId": request_id,
                    "sessionId": session.id,
                    "runtime": session.runtime,
                    "externalSessionId": session.externalSessionId,
                },
            )
            await apply_approval_resolution_to_target_item(
                self._store,
                session_id=session.id,
                approval_id=approval_id,
                target_item_id=_optional_string(command.context.get("targetItemId")),
                status=approval_status,
            )
            return InteractionResolution(
                response=RpcResponsePayload(ok=True, result=result),
                context_patch={"approvalStatus": approval_status},
            )
        except KeyError as exc:
            raise InteractionServiceError(
                "not_found",
                "session not found",
                target_status="failed",
            ) from exc
        except ConnectorOfflineError as exc:
            raise InteractionServiceError(
                "conflict",
                str(exc),
                target_status="failed",
            ) from exc
        except ConnectorRpcError as exc:
            if _approval_no_longer_pending(exc):
                raise InteractionServiceError(
                    "conflict",
                    "approval is no longer pending",
                    target_status="expired",
                    context_patch={
                        "approvalStatus": "expired",
                        "closedReason": "runtime_no_longer_accepts_response",
                    },
                ) from exc
            raise InteractionServiceError(
                "upstream",
                exc.message or exc.code,
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


class InteractionProjectionService:
    def __init__(self, store: InteractionProjectionRepository) -> None:
        self._store = store
        self._session_states = SessionStateService(store)

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


def _approval_no_longer_pending(exc: ConnectorRpcError) -> bool:
    text = f"{exc.code} {exc.message}".lower()
    return any(
        fragment in text
        for fragment in ("not pending", "not found", "expired", "no longer")
    )


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None
