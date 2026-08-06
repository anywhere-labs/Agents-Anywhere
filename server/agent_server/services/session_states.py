from __future__ import annotations

from dataclasses import dataclass

from agent_server.core.models import SessionStatus, SessionView
from agent_server.core.session_states import (
    SessionStateFacts,
    can_interrupt_turn,
    can_start_turn,
    can_steer_turn,
    derive_session_status,
    require_session_transition,
)
from agent_server.services.repository_ports import SessionStateRepository


class SessionStateConflictError(RuntimeError):
    pass


@dataclass(frozen=True)
class SessionStateDecision:
    session: SessionView
    facts: SessionStateFacts

    @property
    def can_start_turn(self) -> bool:
        return can_start_turn(self.session.status)

    @property
    def can_interrupt_turn(self) -> bool:
        return can_interrupt_turn(
            self.session.status,
            has_active_work=self.facts.has_active_run
            or self.facts.has_active_turn,
        )

    @property
    def can_steer_turn(self) -> bool:
        return can_steer_turn(
            self.session.status,
            has_active_turn=self.facts.has_active_turn,
        )


class SessionStateService:
    def __init__(self, store: SessionStateRepository) -> None:
        self._store = store

    async def inspect(
        self,
        session_id: str,
        *,
        observed_status: SessionStatus | None = None,
        settle_stopping: bool = False,
    ) -> SessionStateDecision:
        session = await self._store.get_session(session_id)
        active_run = await self._store.get_active_run(session_id)
        open_turn_id = await self._store.get_open_turn_id(session_id)
        has_active_timeline_item = await self._store.has_active_timeline_item(
            session_id
        )
        facts = SessionStateFacts(
            current_status=session.status,
            observed_status=observed_status,
            has_active_run=active_run is not None,
            has_active_turn=(
                open_turn_id is not None
                or (active_run is not None and active_run.get("turnId") is not None)
                or has_active_timeline_item
            ),
            has_blocking_interaction=False,
            settle_stopping=settle_stopping,
        )
        return SessionStateDecision(session=session, facts=facts)

    async def reconcile(
        self,
        session_id: str,
        *,
        observed_status: SessionStatus | None = None,
        settle_stopping: bool = False,
    ) -> SessionView:
        for _ in range(2):
            decision = await self.inspect(
                session_id,
                observed_status=observed_status,
                settle_stopping=settle_stopping,
            )
            target = derive_session_status(decision.facts)
            if target == decision.session.status:
                return decision.session
            try:
                return await self._store.set_session_status(
                    session_id,
                    target,
                    expected_status=decision.session.status,
                )
            except ValueError:
                continue
        raise SessionStateConflictError("session state changed")

    async def transition(
        self,
        session_id: str,
        target: SessionStatus,
    ) -> SessionView:
        session = await self._store.get_session(session_id)
        require_session_transition(session.status, target)
        try:
            return await self._store.set_session_status(
                session_id,
                target,
                expected_status=session.status,
            )
        except ValueError as exc:
            raise SessionStateConflictError("session state changed") from exc
