"""Hermes as a RuntimeProvider; everything Hermes-specific is in its definition."""

from __future__ import annotations

from ...provider import AcpAgentProvider
from .definition import HERMES


class HermesProvider(AcpAgentProvider):
    def __init__(self):
        super().__init__(HERMES)


def hermes_acp_provider():
    return HermesProvider()
