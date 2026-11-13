from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeSessionStateCache,
    RuntimeUnsupportedError,
    SessionState,
)
from connector.runtimes.codex.domain.selections import (
    model_settings_from_selection,
    permission_settings_from_selection,
    thread_settings_update,
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
    active_turn_ids: Mapping[str, str] = field(default_factory=dict)

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        """Validate and publish session selection changes.

        Side effects:
        - validates the selections against live runtime catalogs
        - applies them to the thread at once when this app-server holds it,
          otherwise stores them for the next turn
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
            model = await model_settings_from_selection(
                selections.get("model"), self.list_model_catalog
            )
            permission = await permission_settings_from_selection(
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
        # A None scope asks for the Runtime default, which thread/settings/update
        # cannot express; such an update waits for the next turn as before.
        settings = (
            thread_settings_update(model, permission)
            if all(value is not None for value in selections.values())
            else {}
        )
        try:
            applied = await self._apply_now(session_id, external_session_id, settings)
        except Exception as exc:  # noqa: BLE001 - app-server refused the settings
            return RuntimeOperationResult(
                ok=False,
                code="codex_thread_settings_rejected",
                message=str(exc) or exc.__class__.__name__,
                result={
                    "sessionId": session_id,
                    "externalSessionId": external_session_id,
                    "selections": dict(selections),
                },
            )
        cached = self.session_states.get(session_id)
        state = await self.session_states.update(
            session_id=session_id,
            external_session_id=external_session_id,
            status=cached.status if cached is not None else "idle",
            selections=selections,
            error=cached.error if cached is not None else None,
            metadata=(
                {
                    "source": "codex.thread/settings/update",
                    "selection_effect": "applied",
                    "pendingSelectionScopes": [],
                }
                if applied
                else {
                    "source": "codex.session.selections.update",
                    "selection_effect": "next_turn",
                    "pendingSelectionScopes": sorted(selections),
                }
            ),
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "updated": True,
                "applied": applied,
                "sessionId": session_id,
                "externalSessionId": external_session_id,
                "selections": dict(selections),
                "state": _session_state_payload(state),
            },
        )

    async def _apply_now(
        self,
        session_id: str,
        external_session_id: str | None,
        settings: Mapping[str, Any],
    ) -> bool:
        """Change the thread's settings now when this app-server holds it.

        A thread nobody has loaded keeps the selections for its next turn:
        loading it would take the writer lock just to change a setting. A
        running turn keeps its sandbox and approval policy, but follows a new
        reviewer at once, as in Codex Desktop.
        """

        if not settings or external_session_id is None:
            return False
        thread_loaded = getattr(self.client, "thread_loaded", None)
        update_thread_settings = getattr(self.client, "update_thread_settings", None)
        if not callable(thread_loaded) or not callable(update_thread_settings):
            return False
        if not thread_loaded(external_session_id):
            return False
        if not await update_thread_settings(external_session_id, settings):
            return False
        turn_id = self.active_turn_ids.get(session_id)
        reviewer = settings.get("approvalsReviewer")
        update_turn_settings = getattr(self.client, "update_turn_settings", None)
        if turn_id and reviewer is not None and callable(update_turn_settings):
            try:
                await update_turn_settings(
                    external_session_id, turn_id, {"approvalsReviewer": reviewer}
                )
            except Exception as exc:  # noqa: BLE001 - the next turn still uses it
                logger.debug(
                    "codex running turn kept its reviewer thread={} turn={} error={}",
                    external_session_id,
                    turn_id,
                    exc,
                )
        return True


def _session_state_payload(state: SessionState) -> dict[str, object]:
    return {
        "sessionId": state.session_id,
        "runtime": state.runtime,
        **(
            {"runtimeId": state.runtime_id}
            if state.runtime_id is not None
            else {}
        ),
        "externalSessionId": state.external_session_id,
        "status": state.status,
        "selections": dict(state.selections),
        "statusReason": state.status_reason,
        "error": (
            dict(state.error)
            if state.error is not None
            else None
        ),
        "metadata": dict(state.metadata),
    }
