from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeCommandResult,
    RuntimeInvalidRequestError,
    RuntimeSessionStateCache,
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
        task.add_done_callback(self.handle_compact_task_done)

    def handle_compact_task_done(self, task: asyncio.Task[None]) -> None:
        self.compact_tasks.discard(task)
        try:
            task.result()
        except asyncio.CancelledError:
            logger.debug("codex compact task cancelled")
        except Exception:
            logger.exception("codex compact task failed unexpectedly")

    async def _run_compact(
        self,
        session_id: str,
        external_session_id: str,
    ) -> None:
        """Call the SDK compact operation.

        Side effects:
        - sends the compact start request to the Codex app server
        - publishes idle/error state when the start request fails

        Successful compact progress is intentionally not published here. The
        Codex app server emits the same compact notifications as a normal
        conversation flow; the notification reducer owns timeline/state updates.
        """
        if self.client is None:
            return
        logger.info(
            "codex compact command starting session_id={} external_session_id={}",
            session_id,
            external_session_id,
        )
        try:
            await self.client.compact_thread(external_session_id)
        except (RuntimeError, RuntimeInvalidRequestError) as exc:
            soft_reason = soft_codex_unavailable_reason(str(exc))
            if soft_reason is not None:
                logger.warning(
                    "codex compact command soft failed session_id={} external_session_id={} reason={}",
                    session_id,
                    external_session_id,
                    soft_reason,
                )
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
            logger.warning(
                "codex compact command failed session_id={} external_session_id={} error_type={} error={}",
                session_id,
                external_session_id,
                exc.__class__.__name__,
                str(exc) or exc.__class__.__name__,
            )
            await self.publish_compact_start_failure_state(
                session_id=session_id,
                external_session_id=external_session_id,
                error_code=exc.__class__.__name__,
                error_message=str(exc) or exc.__class__.__name__,
            )
            return
        except Exception as exc:
            logger.warning(
                "codex compact command failed session_id={} external_session_id={} error_type={} error={}",
                session_id,
                external_session_id,
                exc.__class__.__name__,
                str(exc) or exc.__class__.__name__,
            )
            await self.publish_compact_start_failure_state(
                session_id=session_id,
                external_session_id=external_session_id,
                error_code=exc.__class__.__name__,
                error_message=str(exc) or exc.__class__.__name__,
            )
            return
        logger.info(
            "codex compact command start request completed session_id={} external_session_id={}",
            session_id,
            external_session_id,
        )

    async def publish_compact_start_failure_state(
        self,
        session_id: str,
        external_session_id: str,
        error_code: str,
        error_message: str,
    ) -> None:
        """Publish command-trigger failure as transient session state.

        Side effects:
        - updates SessionState.status to idle with an explicit error payload

        This does not write timeline because no Codex compact event was emitted.
        Compact timeline is owned by the Codex notification reducer.
        """
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
