from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import (
    RuntimeCommandResult,
    RuntimeInvalidRequestError,
    RuntimeSessionStateCache,
    SessionNotice,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain.commands import list_codex_commands
from connector.runtimes.codex.runtime_helpers import soft_codex_unavailable_reason
from connector.runtimes.codex.sdk.runtime_client import CodexRuntimeClient

EnsureStarted = Callable[[], Awaitable[None]]


@dataclass(slots=True)
class CodexCommandController:
    host: RuntimeHostClient
    client: CodexRuntimeClient | None
    session_states: RuntimeSessionStateCache
    ensure_started: EnsureStarted
    compact_tasks: set[asyncio.Task[None]] = field(default_factory=set, init=False)

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
        await self._publish_compact_started(
            session_id=session_id,
            external_session_id=external_session_id,
            result={},
        )
        self._schedule_compact(
            session_id=session_id,
            external_session_id=external_session_id,
        )
        return RuntimeCommandResult(
            command=command_id,
            ok=True,
            code="started",
            message="Codex compaction started.",
            result={
                "externalSessionId": external_session_id,
                "scheduled": True,
            },
        )

    def _schedule_compact(
        self,
        session_id: str,
        external_session_id: str,
    ) -> None:
        task = asyncio.create_task(
            self._run_compact(
                session_id=session_id,
                external_session_id=external_session_id,
            )
        )
        self.compact_tasks.add(task)
        task.add_done_callback(self.compact_tasks.discard)

    async def _run_compact(
        self,
        session_id: str,
        external_session_id: str,
    ) -> None:
        """Call the SDK compact operation and publish follow-up state/notice updates."""
        if self.client is None:
            return
        try:
            result = await self.client.compact_thread(external_session_id)
        except (RuntimeError, RuntimeInvalidRequestError) as exc:
            soft_reason = soft_codex_unavailable_reason(str(exc))
            if soft_reason is not None:
                await self.session_states.update(
                    session_id=session_id,
                    external_session_id=external_session_id,
                    status="idle",
                    metadata={
                        "source": "codex.command.compact.soft-failed",
                        "reason": soft_reason,
                        "command": "compact",
                    },
                )
                return
            await self._publish_compact_failed(
                session_id=session_id,
                external_session_id=external_session_id,
                error_code=exc.__class__.__name__,
                error_message=str(exc) or exc.__class__.__name__,
            )
            return
        except Exception as exc:
            await self._publish_compact_failed(
                session_id=session_id,
                external_session_id=external_session_id,
                error_code=exc.__class__.__name__,
                error_message=str(exc) or exc.__class__.__name__,
            )
            return
        await self._publish_compact_accepted(
            session_id=session_id,
            external_session_id=external_session_id,
            result=dict(result.payload),
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

    async def _publish_compact_accepted(
        self,
        session_id: str,
        external_session_id: str,
        result: dict[str, Any],
    ) -> None:
        cached = self.session_states.get(session_id)
        await self.session_states.update(
            session_id=session_id,
            external_session_id=external_session_id,
            status=cached.status if cached is not None else "idle",
            error=cached.error if cached is not None else None,
            metadata={
                "source": "codex.command.compact.accepted",
                "command": "compact",
                "result": result,
            },
        )

    async def _publish_compact_failed(
        self,
        session_id: str,
        external_session_id: str,
        error_code: str,
        error_message: str,
    ) -> None:
        notice = SessionNotice(
            notice_id=f"notice_command_compact_{session_id}",
            session_id=session_id,
            runtime="codex",
            type="notification",
            title="Codex compaction failed",
            message=error_message,
            severity="error",
            status="closed",
            response_required=False,
            source={
                "command": "compact",
                "threadId": external_session_id,
            },
            context={
                "kind": "compact",
                "command": "compact",
                "externalSessionId": external_session_id,
                "error": {
                    "code": error_code,
                    "message": error_message,
                },
            },
            metadata={"source": "codex.command.compact.failed"},
        )
        await self.host.notice_upsert(notice)
        await self.session_states.update(
            session_id=session_id,
            external_session_id=external_session_id,
            status="idle",
            error={
                "code": error_code,
                "message": error_message,
            },
            metadata={
                "source": "codex.command.compact.failed",
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
