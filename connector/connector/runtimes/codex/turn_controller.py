from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeCommandResult,
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
from connector.runtimes.codex.runtime_client import CodexRuntimeClient
from connector.runtimes.codex.runtime_helpers import (
    ensure_text_only_attachments,
    soft_interrupt_failure_reason,
)
from connector.runtimes.codex.selection import (
    model_settings_from_selection,
    permission_settings_from_selection,
)

EnsureStarted = Callable[[], Awaitable[None]]
ListModelCatalog = Callable[[str | None, int], Awaitable[RuntimeModelCatalog]]
ListPermissionCatalog = Callable[[str | None, int], Awaitable[RuntimePermissionCatalog]]


@dataclass(slots=True)
class CodexTurnController:
    host: RuntimeHostClient
    client: CodexRuntimeClient | None
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    ensure_started: EnsureStarted
    list_model_catalog: ListModelCatalog
    list_permission_catalog: ListPermissionCatalog
    commands: CodexCommandController = field(init=False)
    interactions: CodexInteractionController = field(init=False)

    def __post_init__(self) -> None:
        self.commands = CodexCommandController(
            client=self.client,
            ensure_started=self.ensure_started,
        )
        self.interactions = CodexInteractionController(
            client=self.client,
            session_states=self.session_states,
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
        selected_model = await model_settings_from_selection(
            (selections or {}).get("model"), self.list_model_catalog
        )
        native_permission = await permission_settings_from_selection(
            (selections or {}).get("permission"), self.list_permission_catalog
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
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        ensure_text_only_attachments(attachments)
        if self.client is None or external_session_id is None:
            raise RuntimeUnsupportedError("start_turn")
        await self.ensure_started()
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status="waiting",
            metadata={"source": "codex.turn/start.requested"},
        )
        try:
            result = await self.client.request(
                "turn/start",
                {
                    "threadId": external_session_id,
                    "input": [{"type": "text", "text": content, "text_elements": []}],
                    "clientUserMessageId": client_message_id,
                },
            )
        except Exception as exc:
            await self._set_session_state(
                session_id=session_id,
                external_session_id=external_session_id,
                status="error",
                error={
                    "code": getattr(exc, "code", None) or exc.__class__.__name__,
                    "message": str(exc) or exc.__class__.__name__,
                },
                metadata={"source": "codex.turn/start.failed"},
            )
            raise
        turn_id = codex_sessions.turn_id_from_result(result)
        if turn_id is not None:
            self.active_turn_ids[session_id] = turn_id
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status="running",
            metadata={
                "source": "codex.turn/start",
                **({"turn_id": turn_id} if turn_id else {}),
            },
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "turnId": turn_id,
                "turn": result.get("turn") or result,
                "externalSessionId": external_session_id,
            },
        )

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        ensure_text_only_attachments(attachments)
        if self.client is None or external_session_id is None:
            raise RuntimeUnsupportedError("steer_turn")
        turn_id = self.active_turn_ids.get(session_id)
        if turn_id is None:
            return RuntimeOperationResult(
                ok=False,
                code="codex_no_active_turn",
                message="Codex runtime has no active turn to steer",
                result={"externalSessionId": external_session_id},
            )
        await self.ensure_started()
        result = await self.client.request(
            "turn/steer",
            {
                "threadId": external_session_id,
                "input": [{"type": "text", "text": content, "text_elements": []}],
                "expectedTurnId": turn_id,
                "clientUserMessageId": client_message_id,
            },
        )
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status="running",
            metadata={"source": "codex.turn/steer", "turn_id": turn_id},
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "steered": True,
                "turnId": turn_id,
                "externalSessionId": external_session_id,
                "turn": result.get("turn") or result,
            },
        )

    async def interrupt_turn(
        self,
        session_id: str,
        external_session_id: str | None = None,
        reason: str | None = None,
    ) -> RuntimeOperationResult:
        _ = reason
        if self.client is None or external_session_id is None:
            raise RuntimeUnsupportedError("interrupt_turn")
        turn_id = self.active_turn_ids.get(session_id)
        if turn_id is None:
            return RuntimeOperationResult(
                ok=False,
                code="codex_no_active_turn",
                message="Codex runtime has no active turn to interrupt",
                result={"externalSessionId": external_session_id},
            )
        await self.ensure_started()
        try:
            result = await self.client.request(
                "turn/interrupt",
                {
                    "threadId": external_session_id,
                    "turnId": turn_id,
                },
            )
        except RuntimeError as exc:
            soft_reason = soft_interrupt_failure_reason(str(exc))
            if soft_reason is None:
                raise
            self.active_turn_ids.pop(session_id, None)
            await self._set_session_state(
                session_id=session_id,
                external_session_id=external_session_id,
                status="idle",
                metadata={
                    "source": "codex.turn/interrupt.soft-failed",
                    "reason": soft_reason,
                    "turn_id": turn_id,
                },
            )
            return RuntimeOperationResult(
                ok=False,
                code=soft_reason,
                message="Codex turn was already unavailable to interrupt",
                result={"interrupted": False, "turnId": turn_id},
            )
        self.active_turn_ids.pop(session_id, None)
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status="idle",
            metadata={"source": "codex.turn/interrupt", "turn_id": turn_id},
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "interrupted": True,
                "turnId": turn_id,
                "externalSessionId": external_session_id,
                "turn": result.get("turn") or result,
            },
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
