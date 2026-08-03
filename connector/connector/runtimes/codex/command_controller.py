from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeCommandResult,
    RuntimeSessionStateCache,
    SessionNotice,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.commands import list_codex_commands
from connector.runtimes.codex.runtime_client import CodexRuntimeClient

EnsureStarted = Callable[[], Awaitable[None]]


@dataclass(slots=True)
class CodexCommandController:
    host: RuntimeHostClient
    client: CodexRuntimeClient | None
    session_states: RuntimeSessionStateCache
    ensure_started: EnsureStarted

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        _ = raw
        command_id = command.removeprefix("/")
        if command_id != "compact":
            return RuntimeCommandResult(
                command=command,
                ok=False,
                code="unknown_command",
                message=f"Codex runtime does not support /{command_id}",
            )
        if args:
            return RuntimeCommandResult(
                command=command_id,
                ok=False,
                code="arguments_not_supported",
                message="/compact does not accept arguments.",
            )
        if self.client is None or external_session_id is None:
            disabled_reason = _compact_disabled_reason(
                external_session_id=external_session_id,
                client_available=self.client is not None,
            )
            return RuntimeCommandResult(
                command=command_id,
                ok=False,
                code="command_disabled",
                message=disabled_reason,
            )
        await self.ensure_started()
        try:
            result = await self.client.request(
                "thread/compact/start",
                {"threadId": external_session_id},
            )
        except RuntimeError as exc:
            return RuntimeCommandResult(
                command=command_id,
                ok=False,
                code="codex_command_failed",
                message=str(exc) or exc.__class__.__name__,
                result={
                    "externalSessionId": external_session_id,
                    "error": {
                        "code": exc.__class__.__name__,
                        "message": str(exc) or exc.__class__.__name__,
                    },
                },
            )
        await self._publish_compact_started(
            session_id=session_id,
            external_session_id=external_session_id,
            result=result,
        )
        return RuntimeCommandResult(
            command=command_id,
            ok=True,
            code="started",
            message="Codex compaction started.",
            result={
                "externalSessionId": external_session_id,
                "thread": result,
            },
        )

    async def _publish_compact_started(
        self,
        session_id: str,
        external_session_id: str,
        result: dict[str, Any],
    ) -> None:
        notice = SessionNotice(
            notice_id=f"notice_command_compact_{session_id}",
            session_id=session_id,
            runtime="codex",
            type="notification",
            title="Codex compaction started",
            message="The runtime is compacting the session context.",
            severity="info",
            status="open",
            response_required=False,
            source={
                "command": "compact",
                "threadId": external_session_id,
            },
            context={
                "kind": "compact",
                "command": "compact",
                "externalSessionId": external_session_id,
                "result": result,
            },
            metadata={"source": "codex.command.compact"},
        )
        await self.host.notice_upsert(notice)
        cached = self.session_states.get(session_id)
        await self.session_states.update(
            session_id=session_id,
            external_session_id=external_session_id,
            status=cached.status if cached is not None else "idle",
            error=cached.error if cached is not None else None,
            metadata={
                "source": "codex.command.compact",
                "command": "compact",
                "notice_id": notice.notice_id,
            },
        )


def _compact_disabled_reason(
    external_session_id: str | None,
    client_available: bool,
) -> str:
    commands = list_codex_commands(
        external_session_id=external_session_id,
        client_available=client_available,
        query="compact",
        limit=1,
    )
    if commands:
        return commands[0].disabled_reason or "Codex compact is unavailable."
    return "Codex compact is unavailable."
