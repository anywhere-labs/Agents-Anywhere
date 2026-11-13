"""Codex (ACP) as a RuntimeProvider; everything Codex-specific is in its definition."""

from __future__ import annotations

from ...provider import AcpAgentProvider
from .definition import CODEX


class CodexAcpProvider(AcpAgentProvider):
    def __init__(self):
        super().__init__(CODEX)


def codex_acp_provider():
    return CodexAcpProvider()
