from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeCommandResult,
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeSessionStateCache,
    RuntimeUnsupportedError,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex import sessions as codex_sessions
from connector.runtimes.codex.command_controller import CodexCommandController
from connector.runtimes.codex.interaction_controller import CodexInteractionController
from connector.runtimes.codex.notice_registry import CodexNoticeRegistry
from connector.runtimes.codex.pending_messages import PendingClientMessageRegistry
from connector.runtimes.codex.runtime_client import CodexRuntimeClient
from connector.runtimes.codex.runtime_helpers import ensure_text_only_attachments
from connector.runtimes.codex.selection import (
    model_settings_from_selection,
    permission_settings_from_selection,
)
from connector.runtimes.codex.turn_actions import CodexTurnActions

EnsureStarted = Callable[[], Awaitable[None]]
ListModelCatalog = Callable[[str | None, int], Awaitable[RuntimeModelCatalog]]
ListPermissionCatalog = Callable[[str | None, int], Awaitable[RuntimePermissionCatalog]]


@dataclass(slots=True)
class CodexTurnController:
    host: RuntimeHostClient
    client: CodexRuntimeClient | None
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    notices: CodexNoticeRegistry
    ensure_started: EnsureStarted
    list_model_catalog: ListModelCatalog
    list_permission_catalog: ListPermissionCatalog
    pending_messages: PendingClientMessageRegistry
    actions: CodexTurnActions = field(init=False)
    commands: CodexCommandController = field(init=False)
    interactions: CodexInteractionController = field(init=False)

    def __post_init__(self) -> None:
        self.actions = CodexTurnActions(
            host=self.host,
            client=self.client,
            session_states=self.session_states,
            active_turn_ids=self.active_turn_ids,
            notices=self.notices,
            ensure_started=self.ensure_started,
            pending_messages=self.pending_messages,
            list_model_catalog=self.list_model_catalog,
            list_permission_catalog=self.list_permission_catalog,
        )
        self.commands = CodexCommandController(
            host=self.host,
            client=self.client,
            session_states=self.session_states,
            ensure_started=self.ensure_started,
        )
        self.interactions = CodexInteractionController(
            host=self.host,
            client=self.client,
            session_states=self.session_states,
            active_turn_ids=self.active_turn_ids,
            notices=self.notices,
            ensure_started=self.ensure_started,
        )

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
        ensure_text_only_attachments(attachments)
        if self.client is None:
            raise RuntimeUnsupportedError("create_and_start_session")
        await self.ensure_started()
        if invalid_scope := _unsupported_selection_scope(selections or {}):
            return RuntimeOperationResult(
                ok=False,
                code="codex_invalid_selection_scope",
                message=f"Unsupported Codex selection scope: {invalid_scope}",
                result={"sessionId": session_id, "selections": dict(selections or {})},
            )
        try:
            selected_model = await model_settings_from_selection(
                (selections or {}).get("model"), self.list_model_catalog
            )
            native_permission = await permission_settings_from_selection(
                (selections or {}).get("permission"), self.list_permission_catalog
            )
        except RuntimeInvalidRequestError as exc:
            return RuntimeOperationResult(
                ok=False,
                code="codex_invalid_selection",
                message=str(exc),
                result={"sessionId": session_id, "selections": dict(selections or {})},
            )
        result = await self.client.request(
            "thread/start",
            {
                "cwd": cwd,
                "model": selected_model.get("model"),
                "approvalPolicy": native_permission.get("approvalPolicy"),
                "sandbox": native_permission.get("sandbox"),
                "ephemeral": False,
            },
        )
        thread_id = codex_sessions.thread_id_from_result(result)
        if thread_id is None:
            return RuntimeOperationResult(
                ok=False,
                code="codex_thread_start_failed",
                message="Codex thread/start did not return a thread id",
                result={"raw": result},
            )
        await self.host.session_meta_upsert(
            session_id=session_id,
            runtime="codex",
            external_session_id=thread_id,
            title=title,
            cwd=cwd,
            metadata={"source": "codex.thread/start"},
        )
        await self._set_session_state(
            session_id=session_id,
            external_session_id=thread_id,
            status="idle",
            selections=selections,
            metadata={"source": "codex.thread/start"},
        )
        turn_result = await self.start_turn(
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
                "thread": result.get("thread") or result,
                **turn_result.result,
            },
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        return await self.actions.start_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            content=content,
            selections=selections,
            attachments=attachments,
            client_message_id=client_message_id,
        )

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        return await self.actions.steer_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            content=content,
            attachments=attachments,
            client_message_id=client_message_id,
        )

    async def interrupt_turn(
        self,
        session_id: str,
        external_session_id: str | None = None,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        return await self.actions.interrupt_turn(
            session_id=session_id,
            external_session_id=external_session_id,
            reason=reason,
        )

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        return await self.commands.execute_command(
            session_id=session_id,
            command=command,
            external_session_id=external_session_id,
            raw=raw,
            args=args,
        )

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        return await self.interactions.respond_interaction(
            session_id=session_id,
            notice_id=notice_id,
            action_id=action_id,
            input_data=input_data,
        )

    async def update_session_selections(
        self,
        session_id: str,
        external_session_id: str | None,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        if self.client is None or external_session_id is None:
            raise RuntimeUnsupportedError("update_session_selections")
        if not selections:
            return RuntimeOperationResult(
                ok=False,
                code="codex_empty_selection_update",
                message="At least one selection scope is required.",
                result={"sessionId": session_id, "externalSessionId": external_session_id},
            )
        invalid_scope = _unsupported_selection_scope(selections)
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
            selected_model = await model_settings_from_selection(
                selections.get("model"), self.list_model_catalog
            )
            native_permission = await permission_settings_from_selection(
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
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status=cached.status if cached is not None else "idle",
            selections=selections,
            error=cached.error if cached is not None else None,
            metadata={
                "source": "codex.session.selections.update",
                "selection_scopes": tuple(selections.keys()),
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

    async def _set_session_state(
        self,
        session_id: str,
        external_session_id: str | None,
        status: str,
        selections: Mapping[str, str | None] | None = None,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        await self.session_states.update(
            session_id=session_id,
            external_session_id=external_session_id,
            status=status,  # type: ignore[arg-type]
            selections=selections,
            error=error,
            metadata=metadata,
        )


def _unsupported_selection_scope(
    selections: Mapping[str, str | None],
) -> str | None:
    unsupported_scopes = set(selections) - {"model", "permission"}
    return min(unsupported_scopes) if unsupported_scopes else None
