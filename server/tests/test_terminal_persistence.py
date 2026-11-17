from __future__ import annotations

from agent_server.core.models import TerminalCreateRequest


def test_terminal_create_request_defaults_to_non_persistent() -> None:
    assert TerminalCreateRequest().persistent is False
