from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from connector.runtime_protocol import RuntimeAttachment, RuntimeOperationResult
from connector.runtimes.claude.notifications.projector import ClaudeNotificationProjector
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore
from connector.runtimes.claude.turns.actions import ClaudeTurnActionHandler


@dataclass(slots=True)
class ClaudeSessionStartHandler:
    session_store: ClaudeSessionStore
    notifications: ClaudeNotificationProjector
    actions: ClaudeTurnActionHandler

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
        session = self.session_store.ensure(session_id=session_id, cwd=cwd)
        self.session_store.update_meta(session, title=title, cwd=cwd)
        await self.notifications.session_state.session_meta_upsert(
            session,
            source="claude.create_and_start_session",
        )
        await self.notifications.session_state.session_state_update(
            session,
            "idle",
            metadata={"source": "claude.create_and_start_session"},
        )
        result = await self.actions.start_turn(
            session_id=session_id,
            external_session_id=session.external_session_id,
            content=content,
            selections=selections,
            attachments=attachments,
            client_message_id=client_message_id,
        )
        return RuntimeOperationResult(
            ok=result.ok,
            code=result.code,
            message=result.message,
            result={
                "sessionId": session_id,
                "externalSessionId": session.external_session_id,
                **result.result,
            },
        )
