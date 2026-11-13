from __future__ import annotations

from connector.runtime_protocol import RuntimeProvider
from connector.runtimes.acp.profiles.codex.provider import codex_acp_provider
from connector.runtimes.acp.profiles.hermes.provider import hermes_acp_provider
from connector.runtimes.acp.profiles.pi.provider import pi_acp_provider
from connector.runtimes.claude.provider import ClaudeProvider
from connector.runtimes.codex.provider import CodexProvider
from connector.runtimes.dsh.provider import DshProvider


def default_runtime_providers() -> tuple[RuntimeProvider, ...]:
    return (CodexProvider(), ClaudeProvider(), DshProvider(), pi_acp_provider(), hermes_acp_provider(),
            codex_acp_provider())
