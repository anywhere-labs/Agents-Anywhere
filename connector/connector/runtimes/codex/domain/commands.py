from __future__ import annotations

from connector.runtime_protocol import RuntimeCommand


def list_codex_commands(
    external_session_id: str | None,
    client_available: bool,
    query: str | None = None,
    limit: int = 50,
) -> tuple[RuntimeCommand, ...]:
    _ = external_session_id
    _ = client_available
    _ = query
    _ = limit
    return ()
