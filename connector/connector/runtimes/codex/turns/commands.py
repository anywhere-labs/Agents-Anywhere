from __future__ import annotations

from dataclasses import dataclass

from connector.runtime_protocol import RuntimeCommandResult


@dataclass(slots=True)
class CodexCommandController:
    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        _ = session_id
        _ = external_session_id
        _ = raw
        _ = args
        command_id = command.removeprefix("/")
        return RuntimeCommandResult(
            command=command_id,
            ok=False,
            code="unknown_command",
            message=f"Codex runtime does not support /{command_id}",
        )
