from __future__ import annotations

from connector.runtime_protocol import RuntimeProvider
from connector.runtimes.claude.provider import ClaudeProvider
from connector.runtimes.codex.provider import CodexProvider
from connector.runtimes.dsh.provider import DshProvider

try:
    from connector.runtimes.zcode.provider import ZCodeProvider
    _HAS_ZCODE = True
except Exception:
    _HAS_ZCODE = False

try:
    from connector.runtimes.antigravity.provider import AntigravityProvider
    _HAS_ANTIGRAVITY = True
except Exception:
    _HAS_ANTIGRAVITY = False

try:
    from connector.runtimes.acp.profiles.pi.provider import pi_acp_provider
    _HAS_PI = False
except Exception:
    _HAS_PI = False


def default_runtime_providers() -> tuple[RuntimeProvider, ...]:
    providers: list[RuntimeProvider] = [CodexProvider(), ClaudeProvider(), DshProvider()]
    if _HAS_PI:
        try:
            providers.append(pi_acp_provider())
        except Exception:
            pass
    if _HAS_ZCODE:
        try:
            providers.append(ZCodeProvider())
        except Exception:
            pass
    if _HAS_ANTIGRAVITY:
        try:
            providers.append(AntigravityProvider())
        except Exception:
            pass
    return tuple(providers)
