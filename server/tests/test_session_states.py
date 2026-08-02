from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_server.core.models import Notice, SessionStatus, SessionView
from agent_server.core.session_states import (
    SessionStateDomainError,
    SessionStateFacts,
    can_interrupt_turn,
    can_start_turn,
    can_steer_turn,
    derive_session_status,
    require_session_transition,
)
from agent_server.services.session_states import SessionStateService


@pytest.mark.parametrize(
    ("facts", "expected"),
    [
        (SessionStateFacts(current_status="idle"), "idle"),
        (
            SessionStateFacts(current_status="idle", has_active_run=True),
            "waiting",
        ),
        (
            SessionStateFacts(current_status="pending", has_active_turn=True),
            "running",
        ),
        (
            SessionStateFacts(current_status="idle", observed_status="running"),
            "running",
        ),
        (
            SessionStateFacts(current_status="idle", observed_status="pending"),
            "waiting",
        ),
        (
            SessionStateFacts(current_status="running", observed_status="blocked"),
            "blocked",
        ),
        (
            SessionStateFacts(
                current_status="running",
                has_active_turn=True,
                has_blocking_interaction=True,
            ),
            "blocked",
        ),
        (
            SessionStateFacts(current_status="stopping"),
            "stopping",
        ),
        (
            SessionStateFacts(
                current_status="stopping",
                has_active_turn=True,
                settle_stopping=True,
            ),
            "running",
        ),
        (
            SessionStateFacts(
                current_status="stopping",
                settle_stopping=True,
            ),
            "idle",
        ),
        (
            SessionStateFacts(
                current_status="idle",
                observed_status="stopping",
            ),
            "idle",
        ),
        (
            SessionStateFacts(
                current_status="running",
                observed_status="stopping",
                has_active_turn=True,
            ),
            "stopping",
        ),
    ],
)
def test_session_status_is_derived_from_explicit_facts(
    facts: SessionStateFacts,
    expected: SessionStatus,
) -> None:
    assert derive_session_status(facts) == expected


def test_session_transition_rejects_idle_to_stopping() -> None:
    with pytest.raises(SessionStateDomainError, match="idle to stopping"):
        require_session_transition("idle", "stopping")


def test_session_queries_centralize_start_and_interrupt_rules() -> None:
    assert can_start_turn("idle") is True
    assert can_start_turn("blocked") is False
    assert can_interrupt_turn("idle", has_active_work=False) is False
    assert can_interrupt_turn("idle", has_active_work=True) is True
    assert can_interrupt_turn("blocked", has_active_work=False) is True
    assert can_steer_turn("running", has_active_turn=True) is True
    assert can_steer_turn("blocked", has_active_turn=True) is False
    assert can_steer_turn("running", has_active_turn=False) is False
    assert can_steer_turn("stopping", has_active_turn=True) is False


def test_session_state_service_reconciles_with_compare_and_set() -> None:
    repository = _SessionStateRepository(status="idle", active_run=True)
    service = SessionStateService(repository)

    session = asyncio.run(service.reconcile("session-1"))

    assert session.status == "waiting"
    assert repository.writes == [("waiting", "idle")]


def test_session_state_service_treats_active_timeline_item_as_running() -> None:
    repository = _SessionStateRepository(status="idle", active_timeline_item=True)
    service = SessionStateService(repository)

    session = asyncio.run(service.reconcile("session-1"))

    assert session.status == "running"
    assert repository.writes == [("running", "idle")]


def test_session_state_service_retries_concurrent_equivalent_update() -> None:
    repository = _SessionStateRepository(status="idle", active_run=True)
    repository.conflict_once = True
    service = SessionStateService(repository)

    session = asyncio.run(service.reconcile("session-1"))

    assert session.status == "waiting"
    assert repository.writes == [("waiting", "idle")]


def test_session_reconciliation_can_correct_idle_to_observed_stopping() -> None:
    repository = _SessionStateRepository(status="idle", active_run=True)
    service = SessionStateService(repository)

    session = asyncio.run(
        service.reconcile("session-1", observed_status="stopping")
    )

    assert session.status == "stopping"
    assert repository.writes == [("stopping", "idle")]


class _SessionStateRepository:
    def __init__(
        self,
        *,
        status: SessionStatus,
        active_run: bool = False,
        active_timeline_item: bool = False,
    ) -> None:
        self.session = SessionView(
            id="session-1",
            connectorId="connector-1",
            connectorStatus="online",
            runtime="codex",
            status=status,
            takeover=True,
            updatedSeq=1,
        )
        self.active_run = active_run
        self.active_timeline_item = active_timeline_item
        self.conflict_once = False
        self.writes: list[tuple[SessionStatus, SessionStatus | None]] = []

    async def get_session(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> SessionView:
        if session_id != self.session.id:
            raise KeyError(session_id)
        return self.session

    async def get_active_run(self, session_id: str) -> dict[str, Any] | None:
        assert session_id == self.session.id
        return {"sessionId": session_id} if self.active_run else None

    async def has_active_timeline_item(self, session_id: str) -> bool:
        assert session_id == self.session.id
        return self.active_timeline_item

    async def get_open_turn_id(self, session_id: str) -> str | None:
        assert session_id == self.session.id
        return None

    async def list_open_blocking_notices(self, session_id: str) -> list[Notice]:
        assert session_id == self.session.id
        return []

    async def set_session_status(
        self,
        session_id: str,
        status: SessionStatus,
        *,
        expected_status: SessionStatus | None = None,
    ) -> SessionView:
        assert session_id == self.session.id
        self.writes.append((status, expected_status))
        if self.conflict_once:
            self.conflict_once = False
            self.session = self.session.model_copy(update={"status": status})
            raise ValueError("session status changed")
        if expected_status is not None and self.session.status != expected_status:
            raise ValueError("session status changed")
        self.session = self.session.model_copy(update={"status": status})
        return self.session
