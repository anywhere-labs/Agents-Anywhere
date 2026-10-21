"""Execute native commands once, keeping errors and ambiguous outcomes explicit."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from openai_codex.errors import (
    InvalidParamsError,
    InvalidRequestError,
    MethodNotFoundError,
)

from connector.runtime_protocol import (
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConflictError,
    RuntimeInvalidRequestError,
    RuntimeSessionSourceStateCache,
    RuntimeSessionStateCache,
)
from connector.runtimes.codex.domain.commands import list_codex_commands
from connector.runtimes.codex.sdk.runtime_client import CodexRuntimeClient
from connector.runtimes.codex.turns.command_input import command_input


@dataclass(slots=True)
class CodexCommandController:
    client: CodexRuntimeClient | None
    states: RuntimeSessionStateCache
    source_states: RuntimeSessionSourceStateCache
    ensure_started: Callable[[], Awaitable[None]]

    def catalog(
        self,
        session_id: str,
        thread_id: str | None,
        query: str | None = None,
        limit: int = 50,
    ) -> tuple[RuntimeCommand, ...]:
        state = self.states.get(session_id)
        source = self.source_states.get(session_id)
        return list_codex_commands(
            thread_id,
            self.client is not None,
            query,
            limit,
            status=state.status if state else "idle",
            source_availability=source.state.availability if source else None,
        )

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        requested = command.removeprefix("/") if isinstance(command, str) else ""
        try:
            name, text = command_input(command, raw, args)
            descriptor = next(
                (
                    c
                    for c in self.catalog(session_id, external_session_id)
                    if c.id == name
                ),
                None,
            )
            if descriptor is None:
                return RuntimeCommandResult(
                    command=requested,
                    ok=False,
                    code="unknown_command",
                    message=f"Unknown Codex command: /{requested}",
                )
            if text.strip():
                raise ValueError("This command takes no arguments")
        except (ValueError, TypeError) as exc:
            return RuntimeCommandResult(
                command=requested, ok=False, code="invalid_command", message=str(exc)
            )
        if not descriptor.enabled:
            return RuntimeCommandResult(
                command=requested,
                ok=False,
                code="command_unavailable",
                message=descriptor.disabled_reason,
            )
        await self.ensure_started()
        try:
            compact = await self.client.compact_thread(external_session_id)
            result = dict(compact.payload)
            if result.get("ok") is False or result.get("applied") is False:
                return RuntimeCommandResult(
                    command=requested,
                    ok=False,
                    code="command_error",
                    message="Native command was not applied.",
                    result={**result, "executionState": "completed"},
                )
            return RuntimeCommandResult(
                command=requested, result={**result, "executionState": "accepted"}
            )
        except (
            RuntimeConflictError,
            RuntimeInvalidRequestError,
            InvalidParamsError,
            InvalidRequestError,
            MethodNotFoundError,
        ) as exc:
            return RuntimeCommandResult(
                command=requested,
                ok=False,
                code="command_rejected",
                message=str(exc),
                result={"executionState": "completed"},
            )
        except Exception:  # noqa: BLE001 - post-dispatch ambiguity must not be retried
            return RuntimeCommandResult(
                command=requested,
                ok=False,
                code="command_outcome_unknown",
                message="Command outcome is unknown. Refresh before taking further action.",
                result={"executionState": "unknown", "retryable": False},
            )
