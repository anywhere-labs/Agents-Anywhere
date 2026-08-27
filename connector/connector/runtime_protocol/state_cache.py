from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.models import (
    RuntimeStatus,
    SessionSourceAvailability,
    SessionSourceObservation,
    SessionSourceObservationOrigin,
    SessionSourceState,
    SessionState,
)

SessionStateUpdated = Callable[[SessionState], Awaitable[None]]


class RuntimeSessionStateCache:
    """Small runtime-side cache that merges partial state updates before hosting.

    Runtime adapters receive native events as partial facts: a status changes,
    or a selection changes, or metadata arrives. This helper keeps that merge
    rule in the protocol layer instead of repeating it in every runtime.
    """

    def __init__(
        self,
        runtime: str,
        host: RuntimeHostClient,
        on_state_updated: SessionStateUpdated | None = None,
    ) -> None:
        self._runtime = runtime
        self._host = host
        self._on_state_updated = on_state_updated
        self._states: dict[str, SessionState] = {}
        self._session_ids_by_external_id: dict[str, str] = {}

    def get(self, session_id: str) -> SessionState | None:
        return self._states.get(session_id)

    def get_by_external_session_id(self, external_session_id: str) -> SessionState | None:
        session_id = self._session_ids_by_external_id.get(external_session_id)
        if session_id is None:
            return None
        return self._states.get(session_id)

    async def update(
        self,
        session_id: str,
        external_session_id: str | None,
        status: RuntimeStatus,
        selections: Mapping[str, str | None] | None = None,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> SessionState:
        previous = self._states.get(session_id)
        state = SessionState(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime=self._runtime,
            status=status,
            selections={
                **dict(previous.selections if previous is not None else {}),
                **dict(selections or {}),
            },
            error=error,
            metadata={
                **dict(previous.metadata if previous is not None else {}),
                **dict(metadata or {}),
            },
        )
        if previous is not None and state == previous:
            return previous
        if (
            previous is not None
            and previous.external_session_id is not None
            and previous.external_session_id != external_session_id
        ):
            self._session_ids_by_external_id.pop(previous.external_session_id, None)
        if external_session_id is not None:
            self._session_ids_by_external_id[external_session_id] = session_id
        self._states[session_id] = state
        await self._host.session_state_update(
            session_id=session_id,
            runtime=self._runtime,
            external_session_id=external_session_id,
            status=state.status,
            selections=state.selections,
            error=state.error,
            metadata=state.metadata,
        )
        if self._on_state_updated is not None:
            await self._on_state_updated(state)
        return state


class RuntimeSessionSourceStateCache:
    """Runtime-side cache for the latest source availability observation."""

    def __init__(self, runtime: str, host: RuntimeHostClient) -> None:
        self._runtime = runtime
        self._host = host
        self._observations: dict[str, SessionSourceObservation] = {}
        self._session_ids_by_external_id: dict[str, str] = {}

    def get(self, session_id: str) -> SessionSourceObservation | None:
        return self._observations.get(session_id)

    def get_by_external_session_id(
        self,
        external_session_id: str,
    ) -> SessionSourceObservation | None:
        session_id = self._session_ids_by_external_id.get(external_session_id)
        return self._observations.get(session_id) if session_id is not None else None

    def remember(
        self,
        observation: SessionSourceObservation,
    ) -> SessionSourceObservation:
        previous = self._observations.get(observation.session_id)
        if (
            previous is not None
            and previous.external_session_id is not None
            and previous.external_session_id != observation.external_session_id
        ):
            self._session_ids_by_external_id.pop(previous.external_session_id, None)
        if observation.external_session_id is not None:
            self._session_ids_by_external_id[observation.external_session_id] = (
                observation.session_id
            )
        self._observations[observation.session_id] = observation
        return observation

    async def update(
        self,
        *,
        session_id: str,
        external_session_id: str | None,
        availability: SessionSourceAvailability,
        reason: str | None,
        observed_at: str | None,
        observation_origin: SessionSourceObservationOrigin,
    ) -> SessionSourceObservation:
        observation = self.remember(
            SessionSourceObservation(
                session_id=session_id,
                external_session_id=external_session_id,
                runtime=self._runtime,
                state=SessionSourceState(
                    availability=availability,
                    reason=reason,
                    observed_at=observed_at,
                    observation_origin=observation_origin,
                ),
            )
        )
        await self._host.session_source_update(observation)
        return observation
