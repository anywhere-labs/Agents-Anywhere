"""Command Code as a RuntimeProvider; its specifics live in the definition."""

from __future__ import annotations

from connector.runtime_protocol.errors import RuntimeUnavailableError

from ...provider import AcpAgentProvider
from .definition import COMMAND_CODE
from .installation import installation_metadata, resolve_command_code


class CommandCodeProvider(AcpAgentProvider):
    instance_policy = "single"

    def __init__(self):
        super().__init__(COMMAND_CODE)

    async def discover(self):
        descriptor = await super().discover()
        try:
            installation = resolve_command_code({})
        except RuntimeUnavailableError as error:
            descriptor.metadata["binary"] = {
                "found": False,
                "reason": str(error),
            }
        else:
            descriptor.metadata["binary"] = {
                "found": True,
                **installation_metadata(installation),
            }
        return descriptor


def command_code_acp_provider():
    return CommandCodeProvider()
