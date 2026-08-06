from __future__ import annotations

from typing import Final

from agent_server.core.protocol import ProtocolCapability, ProtocolCapabilitySet

SESSION_SEND_MESSAGE: Final = "session.send_message"
SESSION_INTERRUPT: Final = "session.interrupt"
SESSION_STEER: Final = "session.steer"
SESSION_INTERACTION_APPROVAL: Final = "session.interaction.approval"
RUNTIME_ATTACHMENT: Final = "runtime.attachment"
RUNTIME_CONFIG: Final = "runtime.config"
CATALOG_MODEL: Final = "catalog.model"
CATALOG_PERMISSION: Final = "catalog.permission"
CATALOG_EFFORT: Final = "catalog.effort"


def find_capability(
    capability_set: ProtocolCapabilitySet,
    capability_id: str,
) -> ProtocolCapability | None:
    return next(
        (
            capability
            for capability in capability_set.capabilities
            if capability.capabilityId == capability_id
        ),
        None,
    )


def capability_is_usable(
    capability_set: ProtocolCapabilitySet,
    capability_id: str,
) -> bool:
    capability = find_capability(capability_set, capability_id)
    return bool(
        capability is not None
        and capability.supported
        and capability.available
        and capability.allowed
    )
