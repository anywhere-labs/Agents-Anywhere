from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeSessionStateCache,
    RuntimeUnsupportedError,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain.selections import (
    model_settings_from_selection,
    permission_settings_from_selection,
)
from connector.runtimes.codex.runtime_helpers import ensure_text_only_attachments
from connector.runtimes.codex.sdk.runtime_client import (
    CodexRuntimeClient,
    CodexStartThreadRequest,
)
from connector.runtimes.codex.turns.actions import CodexTurnActions
from connector.runtimes.codex.turns.selection_scopes import unsupported_selection_scope

EnsureStarted = Callable[[], Awaitable[None]]
ListModelCatalog = Callable[[str | None, int], Awaitable[RuntimeModelCatalog]]
ListPermissionCatalog = Callable[[str | None, int], Awaitable[RuntimePermissionCatalog]]


@dataclass(slots=True)
class CodexSessionStartController:
    host: RuntimeHostClient
    client: CodexRuntimeClient | None
    session_states: RuntimeSessionStateCache
    ensure_started: EnsureStarted
    list_model_catalog: ListModelCatalog
    list_permission_catalog: ListPermissionCatalog
    turn_actions: CodexTurnActions

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        """Create a Codex thread, publish session meta/state, then start a turn.

        Side effects:
        - starts the Codex runtime client when needed
        - creates a Codex thread
        - upserts SessionMeta and initial idle SessionState
        - delegates first turn execution to CodexTurnActions
        """

        ensure_text_only_attachments(attachments)
        if self.client is None:
            raise RuntimeUnsupportedError("create_and_start_session")
        await self.ensure_started()
        effective_selections = selections or {}
        if invalid_scope := unsupported_selection_scope(effective_selections):
            return RuntimeOperationResult(
                ok=False,
                code="codex_invalid_selection_scope",
                message=f"Unsupported Codex selection scope: {invalid_scope}",
                result={"sessionId": session_id, "selections": dict(effective_selections)},
            )
        try:
            selected_model = await model_settings_from_selection(
                effective_selections.get("model"), self.list_model_catalog
            )
            native_permission = await permission_settings_from_selection(
                effective_selections.get("permission"), self.list_permission_catalog
            )
        except RuntimeInvalidRequestError as exc:
            return RuntimeOperationResult(
                ok=False,
                code="codex_invalid_selection",
                message=str(exc),
                result={"sessionId": session_id, "selections": dict(effective_selections)},
            )
        result = await self.client.start_thread(
            CodexStartThreadRequest(
                cwd=cwd,
                model=selected_model.model,
                approval_policy=native_permission.approval_policy,
                sandbox=native_permission.sandbox,
                ephemeral=False,
            )
        )
        thread_id = result.thread_id
        if thread_id is None:
            return RuntimeOperationResult(
                ok=False,
                code="codex_thread_start_failed",
                message="Codex thread/start did not return a thread id",
                result={"thread": dict(result.payload)},
            )
        await self.host.session_meta_upsert(
            session_id=session_id,
            runtime="codex",
            external_session_id=thread_id,
            title=title,
            cwd=cwd,
            metadata={"source": "codex.thread/start"},
        )
        await self.session_state_idle_after_thread_start(
            session_id=session_id,
            external_session_id=thread_id,
            selections=effective_selections,
        )
        turn_result = await self.turn_actions.start_turn(
            session_id=session_id,
            external_session_id=thread_id,
            content=content,
            attachments=attachments,
            client_message_id=client_message_id,
        )
        return RuntimeOperationResult(
            ok=turn_result.ok,
            code=turn_result.code,
            message=turn_result.message,
            result={
                "sessionId": session_id,
                "externalSessionId": thread_id,
                "thread": dict(result.payload),
                **turn_result.result,
            },
        )

    async def session_state_idle_after_thread_start(
        self,
        session_id: str,
        external_session_id: str,
        selections: Mapping[str, str | None],
    ) -> None:
        await self.session_states.update(
            session_id=session_id,
            external_session_id=external_session_id,
            status="idle",
            selections=selections,
            metadata={"source": "codex.thread/start"},
        )
