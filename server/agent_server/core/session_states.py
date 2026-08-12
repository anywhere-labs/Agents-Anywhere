from __future__ import annotations

from dataclasses import dataclass

from agent_server.core.models import SessionStatus

SESSION_TRANSITIONS: dict[SessionStatus, frozenset[SessionStatus]] = {
    "idle": frozenset({"waiting", "pending", "running", "waiting_approval", "error", "blocked"}),
    "waiting": frozenset({"idle", "running", "stopping", "waiting_approval", "error", "blocked"}),
    "pending": frozenset({"idle", "running", "stopping", "waiting_approval", "error", "blocked"}),
    "running": frozenset({"idle", "waiting", "pending", "stopping", "waiting_approval", "error", "blocked"}),
    "stopping": frozenset({"idle", "waiting", "pending", "running", "waiting_approval", "error", "blocked"}),
    "waiting_approval": frozenset({"idle", "waiting", "pending", "running", "stopping", "error", "blocked"}),
    "error": frozenset({"idle", "waiting", "pending", "running", "stopping", "waiting_approval", "blocked"}),
    "blocked": frozenset({"idle", "waiting", "pending", "running", "stopping", "waiting_approval", "error"}),
}


class SessionStateDomainError(ValueError):
    pass


@dataclass(frozen=True)
class SessionStateFacts:
    current_status: SessionStatus
    observed_status: SessionStatus | None = None
    has_active_run: bool = False
    has_active_timeline_work: bool = False
    has_blocking_interaction: bool = False
    settle_stopping: bool = False


def derive_session_status(facts: SessionStateFacts) -> SessionStatus:
    if facts.has_blocking_interaction:
        return "waiting_approval"
    if facts.observed_status in {"waiting_approval", "error", "blocked"}:
        return facts.observed_status
    if facts.current_status == "stopping" and not facts.settle_stopping:
        return "stopping"
    if facts.observed_status == "stopping" and (
        facts.has_active_run or facts.has_active_timeline_work
    ):
        return "stopping"
    if facts.has_active_timeline_work:
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


def can_send_session_message(status: SessionStatus) -> bool:
    return status == "idle"
