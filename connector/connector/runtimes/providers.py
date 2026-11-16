from __future__ import annotations

from connector.runtime_protocol import RuntimeProvider
from connector.runtimes.acp.profiles.antigravity.definition import ANTIGRAVITY
from connector.runtimes.acp.profiles.codebuddy.definition import CODEBUDDY
from connector.runtimes.acp.profiles.commandcode.definition import COMMAND_CODE
from connector.runtimes.acp.profiles.hermes.provider import hermes_acp_provider
from connector.runtimes.acp.profiles.mimo.definition import MIMO
from connector.runtimes.acp.profiles.minimax.definition import MINIMAX
from connector.runtimes.acp.profiles.opencode.definition import OPENCODE
from connector.runtimes.acp.profiles.pi.provider import pi_acp_provider
from connector.runtimes.acp.provider import AcpAgentProvider
from connector.runtimes.claude.provider import ClaudeProvider
from connector.runtimes.codex.provider import CodexProvider
from connector.runtimes.dsh.provider import DshProvider


def default_runtime_providers() -> tuple[RuntimeProvider, ...]:
    return (
        CodexProvider(),
        ClaudeProvider(),
        DshProvider(),
        pi_acp_provider(),
        hermes_acp_provider(),
        AcpAgentProvider(COMMAND_CODE),
        AcpAgentProvider(OPENCODE),
        AcpAgentProvider(ANTIGRAVITY),
        AcpAgentProvider(MINIMAX),
        AcpAgentProvider(CODEBUDDY),
        AcpAgentProvider(MIMO),
    )
