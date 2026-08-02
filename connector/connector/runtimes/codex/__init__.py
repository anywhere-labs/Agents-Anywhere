"""Native Codex runtime package.

The pre-protocol Codex adapter is retained under connector._reference.codex.
"""

from connector.runtimes.codex.provider import CodexProvider

__all__ = ["CodexProvider"]
