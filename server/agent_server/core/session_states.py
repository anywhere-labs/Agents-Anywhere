from __future__ import annotations

from dataclasses import dataclass

from agent_server.core.models import SessionStatus

SESSION_TRANSITIONS: dict[SessionStatus, frozenset[SessionStatus]] = {
    "idle": frozenset({"waiting", "pending", "running", "blocked"}),
    "waiting": frozenset({"idle", "running", "stopping", "blocked"}),
    "pending": frozenset({"idle", "running", "stopping", "blocked"}),
    "running": frozenset({"idle", "waiting", "pending", "stopping", "blocked"}),
    "stopping": frozenset({"idle", "waiting", "pending", "running", "blocked"}),
    "blocked": frozenset({"idle", "waiting", "pending", "running", "stopping"}),
}


class SessionStateDomainError(ValueError):
    pass


@dataclass(frozen=True)
class SessionStateFacts:
    current_status: SessionStatus
    observed_status: SessionStatus | None = None
    has_active_run: bool = False
    has_active_turn: bool = False
    has_blocking_interaction: bool = False
    settle_stopping: bool = False


def derive_session_status(facts: SessionStateFacts) -> SessionStatus:
    if facts.has_blocking_interaction:
        return "blocked"
    if facts.observed_status == "blocked":
        return "blocked"
    if facts.current_status == "stopping" and not facts.settle_stopping:
        return "stopping"
    if facts.observed_status == "stopping" and (
        facts.has_active_run or facts.has_active_turn
    ):
        return "stopping"
    if facts.has_active_turn:
        return "running"
    if facts.observed_status == "running":
        return "running"
    if facts.has_active_run:
        return "waiting"
    if facts.observed_status == "waiting":
        return "waiting"
    if facts.observed_status == "pending":
        return "waiting"
    return "idle"


def require_session_transition(
    current: SessionStatus,
    target: SessionStatus,
) -> None:
    if current == target:
        return
    if target not in SESSION_TRANSITIONS[current]:
        raise SessionStateDomainError(
            f"session cannot transition from {current} to {target}"
        )


def can_start_turn(status: SessionStatus) -> bool:
    return status == "idle"


def can_interrupt_turn(
    status: SessionStatus,
    *,
    has_active_work: bool,
) -> bool:
    return has_active_work or status in {"waiting", "pending", "running", "blocked"}


def can_steer_turn(
    status: SessionStatus,
    *,
    has_active_turn: bool,
) -> bool:
    return has_active_turn and status == "running"
