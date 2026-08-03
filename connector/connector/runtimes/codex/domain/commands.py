from __future__ import annotations

from connector.runtime_protocol import RuntimeCommand


def list_codex_commands(
    external_session_id: str | None,
    client_available: bool,
    query: str | None = None,
    limit: int = 50,
) -> tuple[RuntimeCommand, ...]:
    commands = (
        RuntimeCommand(
            id="compact",
            title="Compact conversation",
            description="Ask Codex to compact this thread's context.",
            aliases=("summarize",),
            category="context",
            scope="session",
            enabled=external_session_id is not None and client_available,
            disabled_reason=(
                None
                if external_session_id is not None and client_available
                else "Codex compact requires a loaded local thread."
            ),
        ),
    )
    if query:
        lowered = query.casefold()
        commands = tuple(
            command
            for command in commands
            if lowered in command.id.casefold()
            or lowered in command.title.casefold()
            or any(lowered in alias.casefold() for alias in command.aliases)
        )
    return commands[:limit]
