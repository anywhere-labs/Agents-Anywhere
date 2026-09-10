from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeOperationResult,
    RuntimeSessionStateCache,
)
from connector.runtimes.claude.catalogs.reader import ClaudeCatalogReader
from connector.runtimes.claude.domain.selections import effective_claude_selections
from connector.runtimes.claude.notifications.projector import ClaudeNotificationProjector
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore


@dataclass(slots=True)
class ClaudeSelectionController:
    session_states: RuntimeSessionStateCache
    session_store: ClaudeSessionStore
    catalogs: ClaudeCatalogReader
    notifications: ClaudeNotificationProjector

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        session = self.session_store.ensure(
            session_id=session_id,
            external_session_id=external_session_id,
        )
        try:
            session.selections = self.effective_selections(session_id, selections)
        except RuntimeInvalidRequestError as exc:
            return RuntimeOperationResult(
                ok=False,
                code="claude_invalid_selection",
                message=str(exc),
            )
        state = self.session_states.get(session_id)
        await self.notifications.session_state.session_state_update(
            session,
            state.status if state is not None else "idle",
            selections=session.selections,
            metadata={"source": "claude.selections.update"},
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "sessionId": session_id,
                "externalSessionId": session.external_session_id,
                "selections": session.selections,
            },
        )

    def effective_selections(
        self,
        session_id: str,
        selections: Mapping[str, str | None] | None,
    ) -> dict[str, str | None]:
        state = self.session_states.get(session_id)
        return effective_claude_selections(
            state.selections if state is not None else {},
            selections,
            custom_models=self.catalogs.custom_models,
        )
