from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeSessionStateCache,
    RuntimeUnsupportedError,
)
from connector.runtimes.codex.domain.selections import (
    model_settings_from_selection,
    permission_settings_from_selection,
)
from connector.runtimes.codex.sdk.runtime_client import CodexRuntimeClient
from connector.runtimes.codex.turns.selection_scopes import unsupported_selection_scope

ListModelCatalog = Callable[[str | None, int], Awaitable[RuntimeModelCatalog]]
ListPermissionCatalog = Callable[[str | None, int], Awaitable[RuntimePermissionCatalog]]
EnsureStarted = Callable[[], Awaitable[None]]


@dataclass(slots=True)
class CodexSelectionController:
    client: CodexRuntimeClient | None
    session_states: RuntimeSessionStateCache
    ensure_started: EnsureStarted
    list_model_catalog: ListModelCatalog
    list_permission_catalog: ListPermissionCatalog

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        """Validate and publish session selection changes.

        Side effects:
        - validates the selections against live runtime catalogs
        - stores the selections as the session preference for the next turn
        - publishes SessionState.selections while preserving current status/error
        """

        if self.client is None:
            raise RuntimeUnsupportedError("update_session_selections")
        await self.ensure_started()
        if not selections:
            return RuntimeOperationResult(
                ok=False,
                code="codex_empty_selection_update",
                message="At least one selection scope is required.",
                result={
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                },
            )
        invalid_scope = unsupported_selection_scope(selections)
        if invalid_scope is not None:
            return RuntimeOperationResult(
                ok=False,
                code="codex_invalid_selection_scope",
                message=f"Unsupported Codex selection scope: {invalid_scope}",
                result={
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                    "selections": dict(selections),
                },
            )
        try:
            await model_settings_from_selection(
                selections.get("model"), self.list_model_catalog
            )
            await permission_settings_from_selection(
                selections.get("permission"), self.list_permission_catalog
            )
        except RuntimeInvalidRequestError as exc:
            return RuntimeOperationResult(
                ok=False,
                code="codex_invalid_selection",
                message=str(exc),
                result={
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                    "selections": dict(selections),
                },
            )
        cached = self.session_states.get(session_id)
        await self.session_states.update(
            session_id=session_id,
            external_session_id=external_session_id,
            status=cached.status if cached is not None else "idle",
            selections=selections,
            error=cached.error if cached is not None else None,
            metadata={
                "source": "codex.session.selections.update",
                "selection_scopes": tuple(selections.keys()),
                "selection_effect": "next_turn",
            },
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "updated": True,
                "sessionId": session_id,
                "externalSessionId": external_session_id,
                "selections": dict(selections),
            },
        )
