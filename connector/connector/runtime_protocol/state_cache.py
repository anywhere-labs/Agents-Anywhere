from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.models import RuntimeStatus, SessionState


class RuntimeSessionStateCache:
    """Small runtime-side cache that merges partial state updates before hosting.

    Runtime adapters receive native events as partial facts: a status changes,
    or a selection changes, or metadata arrives. This helper keeps that merge
    rule in the protocol layer instead of repeating it in every runtime.
    """

    def __init__(self, runtime: str, host: RuntimeHostClient) -> None:
        self._runtime = runtime
        self._host = host
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
        return state
