from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeInvalidRequestError,
    RuntimeOperationResult,
    RuntimeSessionStateCache,
    RuntimeUnsupportedError,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.domain.selections import (
    model_settings_from_selection,
    permission_settings_from_selection,
)
from connector.runtimes.codex.runtime_helpers import (
    ensure_text_only_attachments,
    soft_interrupt_failure_reason,
)
from connector.runtimes.codex.sdk.runtime_client import (
    CodexInterruptTurnRequest,
    CodexRuntimeClient,
    CodexStartTurnRequest,
    CodexSteerTurnRequest,
)

EnsureStarted = Callable[[], Awaitable[None]]


@dataclass(slots=True)
class CodexTurnActions:
    host: RuntimeHostClient
    client: CodexRuntimeClient | None
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    notices: CodexNoticeRegistry
    ensure_started: EnsureStarted
    pending_messages: PendingClientMessageRegistry
    list_model_catalog: Callable[[str | None, int], Awaitable[Any]] | None = None
    list_permission_catalog: Callable[[str | None, int], Awaitable[Any]] | None = None

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        ensure_text_only_attachments(attachments)
        if self.client is None or external_session_id is None:
            raise RuntimeUnsupportedError("start_turn")
        await self.ensure_started()
        effective_selections = dict(selections or {})
        if not effective_selections:
            cached = self.session_states.get(session_id)
            effective_selections = dict(cached.selections if cached is not None else {})
        try:
            selected_model = (
                await model_settings_from_selection(
                    effective_selections.get("model"),
                    self.list_model_catalog,
                )
                if self.list_model_catalog is not None
                else {}
            )
            native_permission = (
                await permission_settings_from_selection(
                    effective_selections.get("permission"),
                    self.list_permission_catalog,
                )
                if self.list_permission_catalog is not None
                else {}
            )
        except RuntimeInvalidRequestError as exc:
            return RuntimeOperationResult(
                ok=False,
                code="codex_invalid_selection",
                message=str(exc),
                result={"externalSessionId": external_session_id},
            )
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status="waiting",
            selections=effective_selections,
            metadata={"source": "codex.turn/start.requested"},
        )
        self.pending_messages.register(
            session_id=session_id,
            external_session_id=external_session_id,
            client_message_id=client_message_id,
            text=content,
        )
        try:
            result = await self.client.start_turn(
                CodexStartTurnRequest(
                    thread_id=external_session_id,
                    content=content,
                    client_message_id=client_message_id,
                    model=selected_model.model,
                    effort=selected_model.effort,
                    approval_policy=native_permission.approval_policy,
                    sandbox=native_permission.sandbox,
                )
            )
        except Exception as exc:
            await self._set_session_state(
                session_id=session_id,
                external_session_id=external_session_id,
                status="error",
                error={
                    "code": exc.__class__.__name__,
                    "message": str(exc) or exc.__class__.__name__,
                },
                metadata={"source": "codex.turn/start.failed"},
            )
            raise
        turn_id = result.turn_id
        current_state = self.session_states.get(session_id)
        if turn_completed_before_start_returned(current_state):
            return RuntimeOperationResult(
                ok=True,
                result={
                    "turnId": turn_id,
                    "turn": dict(result.payload),
                    "externalSessionId": external_session_id,
                    "status": current_state.status if current_state is not None else None,
                    "completed": True,
                },
            )
        if turn_id is not None:
            self.active_turn_ids[session_id] = turn_id
            self.pending_messages.bind_turn(
                session_id=session_id,
                client_message_id=client_message_id,
                turn_id=turn_id,
            )
        await self._set_session_state(
            session_id=session_id,
            external_session_id=external_session_id,
            status="running",
            selections=effective_selections,
            metadata={
                "source": "codex.turn/start",
                **({"turn_id": turn_id} if turn_id else {}),
            },
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "turnId": turn_id,
                "turn": dict(result.payload),
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
            await self._set_session_state(
                session_id=session_id,
                external_session_id=external_session_id,
                status="idle",
                metadata={"source": "codex.turn/steer.no-active-turn"},
            )
            return RuntimeOperationResult(
                ok=False,
                code="codex_no_active_turn",
                message="Codex runtime has no active turn to steer",
                result={"externalSessionId": external_session_id},
            )
        await self.ensure_started()
        self.pending_messages.register(
            session_id=session_id,
            external_session_id=external_session_id,
            client_message_id=client_message_id,
            text=content,
            steering=True,
            turn_id=turn_id,
        )
        result = await self.client.steer_turn(
            CodexSteerTurnRequest(
                thread_id=external_session_id,
                turn_id=turn_id,
                content=content,
                client_message_id=client_message_id,
            )
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
                "turn": dict(result.payload),
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
            await self._set_session_state(
                session_id=session_id,
                external_session_id=external_session_id,
                status="idle",
                metadata={"source": "codex.turn/interrupt.no-active-turn"},
            )
            return RuntimeOperationResult(
                ok=False,
                code="codex_no_active_turn",
                message="Codex runtime has no active turn to interrupt",
                result={"externalSessionId": external_session_id},
            )
        await self.ensure_started()
        try:
            result = await self.client.interrupt_turn(
                CodexInterruptTurnRequest(
                    thread_id=external_session_id,
                    turn_id=turn_id,
                )
            )
        except RuntimeError as exc:
            soft_reason = soft_interrupt_failure_reason(str(exc))
            if soft_reason is None:
                raise
            self.active_turn_ids.pop(session_id, None)
            await self._close_blocking_notices_for_interrupted_turn(session_id)
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
        await self._close_blocking_notices_for_interrupted_turn(session_id)
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
                "turn": dict(result.payload),
            },
        )

    async def _close_blocking_notices_for_interrupted_turn(
        self,
        session_id: str,
    ) -> None:
        for notice in self.notices.close_open_for_session(
            session_id=session_id,
            status="closed",
            reason="interrupted",
            source="codex.turn/interrupt",
        ):
            await self.host.notice_upsert(notice)

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


def turn_completed_before_start_returned(state: Any | None) -> bool:
    if state is None:
        return False
    if state.status not in {"idle", "blocked"}:
        return False
    source = state.metadata.get("source")
    if not isinstance(source, str):
        return False
    return source in {
        "codex.turn/completed",
        "codex.turn/interrupted",
        "codex.turn/cancelled",
        "codex.turn/failed",
    }
