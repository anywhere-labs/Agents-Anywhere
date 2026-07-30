from __future__ import annotations

import asyncio
from typing import Any

import pytest

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
    InteractionType,
    Notice,
    NoticeAction,
    NoticeIn,
    NoticeStatus,
    RpcResponsePayload,
    SessionView,
)
from agent_server.services.interactions import (
    InteractionProjectionService,
    InteractionResolution,
    InteractionService,
    InteractionServiceError,
)


def test_interaction_state_machine_accepts_ordered_response_flow() -> None:
    interaction = _interaction(status="open")
    require_interaction_transition(interaction, "response_accepted")
    require_interaction_transition(
        interaction.model_copy(update={"status": "response_accepted"}),
        "resolving",
    )
    require_interaction_transition(
        interaction.model_copy(update={"status": "resolving"}),
        "resolved",
    )
    require_interaction_transition(
        interaction.model_copy(update={"status": "failed"}),
        "response_accepted",
    )


@pytest.mark.parametrize("status", ["resolved", "expired", "cancelled"])
def test_interaction_state_machine_rejects_terminal_transitions(
    status: NoticeStatus,
) -> None:
    with pytest.raises(InteractionDomainError, match="cannot transition"):
        require_interaction_transition(
            _interaction(status=status),
            "response_accepted",
        )


def test_prepare_interaction_response_validates_action_and_session() -> None:
    interaction = _interaction()

    command = prepare_interaction_response(
        interaction,
        session_id=interaction.sessionId,
        action_id="continue",
        input_data={"confirmed": True},
    )

    assert command.action_id == "continue"
    assert command.input == {"confirmed": True}
    with pytest.raises(InteractionDomainError) as wrong_session:
        prepare_interaction_response(
            interaction,
            session_id="other-session",
            action_id="continue",
        )
    assert wrong_session.value.code == "wrong_session"
    with pytest.raises(InteractionDomainError) as invalid_action:
        prepare_interaction_response(
            interaction,
            session_id=interaction.sessionId,
            action_id="unknown",
        )
    assert invalid_action.value.code == "invalid_action"


def test_new_interaction_must_enter_through_open_state() -> None:
    interaction = NoticeIn(
        noticeId="interaction-new",
        type="interaction",
        sessionId="session-1",
        title="Input required",
        status="resolved",
        interactionType="input_request",
        responseRequired=True,
        actions=[NoticeAction(actionId="submit", label="Submit")],
    )

    with pytest.raises(InteractionDomainError, match="must be open"):
        require_new_interaction(interaction)


def test_interaction_service_resolves_generic_interaction_through_state_machine() -> None:
    repository = _InteractionRepository(_interaction())
    resolver = _ApprovalResolver()
    service = InteractionService(repository, resolver)

    result = asyncio.run(
        service.respond(
            "session-1",
            "interaction-1",
            action_id="continue",
            input_data=None,
            user_id="user-1",
        )
    )

    assert result == RpcResponsePayload(ok=True, result={"resolved": True})
    assert repository.statuses == ["response_accepted", "resolving", "resolved"]
    assert repository.notice.context["response"] == {
        "actionId": "continue",
        "input": {},
    }
    assert resolver.commands == []


def test_interaction_service_marks_expired_approval_and_reports_changed_error() -> None:
    repository = _InteractionRepository(
        _interaction(
            interaction_type="approval",
            action_id="approve",
            context={"approvalId": "approval-1"},
        )
    )
    resolver = _ApprovalResolver(
        error=InteractionServiceError(
            "conflict",
            "approval is no longer pending",
            target_status="expired",
        )
    )
    service = InteractionService(repository, resolver)

    with pytest.raises(InteractionServiceError) as raised:
        asyncio.run(
            service.respond(
                "session-1",
                "interaction-1",
                action_id="approve",
                input_data=None,
                user_id="user-1",
            )
        )

    assert raised.value.kind == "conflict"
    assert raised.value.changed is True
    assert repository.statuses == ["response_accepted", "resolving", "expired"]
    assert repository.notice.context["error"] == "approval is no longer pending"
    assert resolver.commands[0].context["approvalId"] == "approval-1"


def test_interaction_service_reports_compare_and_set_conflict() -> None:
    repository = _InteractionRepository(_interaction())
    repository.conflict_on_update = 2
    service = InteractionService(repository, _ApprovalResolver())

    with pytest.raises(InteractionServiceError) as raised:
        asyncio.run(
            service.respond(
                "session-1",
                "interaction-1",
                action_id="continue",
                input_data=None,
                user_id="user-1",
            )
        )

    assert raised.value.kind == "conflict"
    assert raised.value.changed is True
    assert repository.statuses == ["response_accepted"]


def test_interaction_projection_normalizes_legacy_approval_session() -> None:
    repository = _ProjectionRepository()
    service = InteractionProjectionService(repository)
    approval = _approval(session_id="external-session")

    projection = asyncio.run(
        service.project_approval(approval, session_id="session-1")
    )

    assert projection.approval.sessionId == "session-1"
    assert projection.interaction.sessionId == "session-1"
    assert projection.interaction.interactionType == "approval"
    assert projection.interaction.context["approvalId"] == "approval-1"
    assert repository.refreshed == ["session-1"]


class _InteractionRepository:
    def __init__(self, notice: Notice) -> None:
        self.notice = notice
        self.statuses: list[str] = []
        self.conflict_on_update: int | None = None
        self.update_calls = 0
        self.session = SessionView(
            id="session-1",
            connectorId="connector-1",
            connectorStatus="online",
            runtime="codex",
            status="blocked",
            takeover=True,
            updatedSeq=1,
        )

    async def get_session(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> SessionView:
        if session_id != self.session.id or user_id != "user-1":
            raise KeyError(session_id)
        return self.session

    async def get_notice(self, notice_id: str) -> Notice:
        if notice_id != self.notice.noticeId:
            raise KeyError(notice_id)
        return self.notice

    async def update_notice_status(
        self,
        notice_id: str,
        status: str,
        *,
        expected_status: str | None = None,
        context_patch: dict[str, Any] | None = None,
    ) -> Notice:
        assert notice_id == self.notice.noticeId
        self.update_calls += 1
        if self.conflict_on_update == self.update_calls:
            raise ValueError("interaction status changed")
        if expected_status is not None and self.notice.status != expected_status:
            raise ValueError("interaction status changed")
        self.statuses.append(status)
        self.notice = self.notice.model_copy(
            update={
                "status": status,
                "context": {**self.notice.context, **(context_patch or {})},
                "updatedSeq": self.notice.updatedSeq + 1,
            }
        )
        return self.notice


class _ApprovalResolver:
    def __init__(self, *, error: InteractionServiceError | None = None) -> None:
        self.error = error
        self.commands: list[InteractionResponseCommand] = []

    async def respond(
        self,
        command: InteractionResponseCommand,
        *,
        user_id: str,
    ) -> InteractionResolution:
        assert user_id == "user-1"
        self.commands.append(command)
        if self.error is not None:
            raise self.error
        return InteractionResolution(
            response=RpcResponsePayload(ok=True, result={"approval": "resolved"}),
            context_patch={"approvalStatus": "approved"},
        )


class _ProjectionRepository:
    def __init__(self) -> None:
        self.refreshed: list[str] = []
        self.approval: Approval | None = None
        self.notice: Notice | None = None

    async def upsert_approval(self, approval: ApprovalIn) -> Approval:
        self.approval = Approval.model_validate(
            {
                **approval.model_dump(mode="json"),
                "updatedSeq": 1,
                "createdAt": "2026-07-30T10:00:00Z",
            }
        )
        return self.approval

    async def upsert_notice(self, notice: NoticeIn) -> Notice:
        self.notice = Notice.model_validate(
            {
                **notice.model_dump(mode="json", by_alias=True),
                "updatedSeq": 2,
                "createdAt": "2026-07-30T10:00:00Z",
                "updatedAt": "2026-07-30T10:00:00Z",
            }
        )
        return self.notice

    async def refresh_session_status_from_timeline(
        self,
        session_id: str,
    ) -> SessionView:
        self.refreshed.append(session_id)
        return SessionView(
            id=session_id,
            connectorId="connector-1",
            connectorStatus="online",
            runtime="codex",
            status="blocked",
            takeover=True,
            updatedSeq=2,
        )


def _interaction(
    *,
    status: NoticeStatus = "open",
    interaction_type: InteractionType = "execution_error",
    action_id: str = "continue",
    context: dict[str, Any] | None = None,
) -> Notice:
    return Notice(
        noticeId="interaction-1",
        type="interaction",
        sessionId="session-1",
        title="Action required",
        status=status,
        interactionType=interaction_type,
        responseRequired=True,
        actions=[NoticeAction(actionId=action_id, label="Continue")],
        context=context or {},
        updatedSeq=1,
        createdAt="2026-07-30T10:00:00Z",
        updatedAt="2026-07-30T10:00:00Z",
    )


def _approval(*, session_id: str) -> ApprovalIn:
    return ApprovalIn(
        id="approval-1",
        sessionId=session_id,
        turnId="turn-1",
        kind="command",
        targetItemId="tool-1",
        title="Approve command",
        payload={"command": "pwd"},
        choices=["approve", "reject"],
        source={
            "runtime": "codex",
            "requestId": "request-1",
            "sessionId": session_id,
        },
    )
