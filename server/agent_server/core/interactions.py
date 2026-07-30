from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from agent_server.core.models import Notice, NoticeIn, NoticeStatus

InteractionDomainErrorCode = Literal[
    "not_interaction",
    "wrong_session",
    "not_open",
    "invalid_action",
    "invalid_definition",
    "invalid_transition",
]

INTERACTION_TRANSITIONS: dict[NoticeStatus, frozenset[NoticeStatus]] = {
    "open": frozenset({"response_accepted", "failed", "expired", "cancelled"}),
    "response_accepted": frozenset(
        {"resolving", "resolved", "failed", "expired", "cancelled"}
    ),
    "resolving": frozenset({"resolved", "failed", "expired", "cancelled"}),
    "failed": frozenset({"response_accepted", "expired", "cancelled"}),
    "resolved": frozenset(),
    "expired": frozenset(),
    "cancelled": frozenset(),
}


class InteractionDomainError(ValueError):
    def __init__(self, code: InteractionDomainErrorCode, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class InteractionResponseCommand:
    interaction_id: str
    session_id: str
    interaction_type: str
    action_id: str
    input: dict[str, Any]
    context: dict[str, Any]


def prepare_interaction_response(
    interaction: Notice,
    *,
    session_id: str,
    action_id: str,
    input_data: dict[str, Any] | None = None,
) -> InteractionResponseCommand:
    if interaction.type != "interaction" or interaction.interactionType is None:
        raise InteractionDomainError("not_interaction", "interaction not found")
    if interaction.sessionId != session_id:
        raise InteractionDomainError("wrong_session", "interaction not found")
    if interaction.status not in {"open", "failed"}:
        raise InteractionDomainError("not_open", "interaction is not open")
    if action_id not in {action.actionId for action in interaction.actions}:
        raise InteractionDomainError("invalid_action", "invalid interaction action")
    return InteractionResponseCommand(
        interaction_id=interaction.noticeId,
        session_id=interaction.sessionId,
        interaction_type=interaction.interactionType,
        action_id=action_id,
        input=dict(input_data or {}),
        context=dict(interaction.context),
    )


def require_new_interaction(interaction: NoticeIn) -> None:
    if interaction.type != "interaction" or interaction.interactionType is None:
        raise InteractionDomainError(
            "invalid_definition",
            "interaction type is required",
        )
    if interaction.status != "open":
        raise InteractionDomainError(
            "invalid_definition",
            "new interaction must be open",
        )
    if interaction.responseRequired and not interaction.actions:
        raise InteractionDomainError(
            "invalid_definition",
            "response-required interaction must define actions",
        )


def require_interaction_transition(
    interaction: Notice,
    target: NoticeStatus,
) -> None:
    if interaction.type != "interaction":
        raise InteractionDomainError("not_interaction", "notice is not an interaction")
    if target not in INTERACTION_TRANSITIONS[interaction.status]:
        raise InteractionDomainError(
            "invalid_transition",
            f"interaction cannot transition from {interaction.status} to {target}",
        )
