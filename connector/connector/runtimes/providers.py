from __future__ import annotations

from connector.runtime_protocol import RuntimeProvider
from connector.runtimes.claude.provider import ClaudeProvider
from connector.runtimes.codex.provider import CodexProvider
from connector.runtimes.dsh.provider import DshProvider
from connector.runtimes.opencode.provider import OpenCodeProvider


def default_runtime_providers() -> tuple[RuntimeProvider, ...]:
    return (CodexProvider(), ClaudeProvider(), DshProvider(), OpenCodeProvider())
