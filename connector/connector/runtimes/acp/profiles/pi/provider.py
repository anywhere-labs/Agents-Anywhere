"""Pi as a RuntimeProvider; everything Pi-specific is in its definition and dialect."""

from __future__ import annotations

from ...provider import AcpAgentProvider
from .definition import LOCAL_MODE_REASON, MODEL_CONNECTION, PI, source_changed


class PiProvider(AcpAgentProvider):
    def __init__(self):
        super().__init__(PI)


def pi_acp_provider():
    return PiProvider()


__all__ = ["LOCAL_MODE_REASON", "MODEL_CONNECTION", "PiProvider", "pi_acp_provider", "source_changed"]
