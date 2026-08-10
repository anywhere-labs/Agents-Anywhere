from __future__ import annotations

from dataclasses import dataclass

from connector.runtime_protocol import (
    CAPABILITY_CATALOG_EFFORT,
    CAPABILITY_CATALOG_MODEL,
    CAPABILITY_CATALOG_PERMISSION,
    CAPABILITY_RUNTIME_ATTACHMENT,
    CAPABILITY_SESSION_INTERACTION_APPROVAL,
    CAPABILITY_SESSION_INTERRUPT,
    CAPABILITY_SESSION_SEND_MESSAGE,
    CAPABILITY_SESSION_STEER,
    RuntimeCapability,
    RuntimeCapabilitySet,
)
from connector.runtimes.claude import provider_config


@dataclass(frozen=True, slots=True)
class ClaudeCapabilityContext:
    connector_id: str
    revision: int
    session_id: str | None = None
    has_active_turn: bool = False


def claude_runtime_capabilities(
    context: ClaudeCapabilityContext,
) -> RuntimeCapabilitySet:
    capabilities = provider_config.claude_capabilities()
    return RuntimeCapabilitySet(
        runtime="claude",
        revision=context.revision,
        connector_id=context.connector_id,
        capabilities=tuple(
            RuntimeCapability(
                capability_id=protocol_id,
                scope="runtime",
                runtime="claude",
                connector_id=context.connector_id,
                supported=supported,
                available=supported,
                allowed=True,
                unavailable_reason=None if supported else "not_implemented",
                metadata={"source": "claude.runtime"},
            )
            for inventory_key, protocol_id in (
                ("modelCatalog", CAPABILITY_CATALOG_MODEL),
                ("modelCatalog", CAPABILITY_CATALOG_EFFORT),
                ("permissionCatalog", CAPABILITY_CATALOG_PERMISSION),
                ("startTurn", CAPABILITY_SESSION_SEND_MESSAGE),
                ("steerTurn", CAPABILITY_SESSION_STEER),
                ("interruptTurn", CAPABILITY_SESSION_INTERRUPT),
                ("interactions", CAPABILITY_SESSION_INTERACTION_APPROVAL),
                ("attachments", CAPABILITY_RUNTIME_ATTACHMENT),
            )
            for supported in (capabilities.get(inventory_key) is True,)
        ),
        metadata={"source": "claude.runtime"},
    )


def claude_session_capabilities(
    context: ClaudeCapabilityContext,
) -> RuntimeCapabilitySet:
    session_id = context.session_id
    active = context.has_active_turn
    return RuntimeCapabilitySet(
        runtime="claude",
        revision=context.revision,
        session_id=session_id,
        connector_id=context.connector_id,
        capabilities=(
            RuntimeCapability(
                capability_id=CAPABILITY_SESSION_SEND_MESSAGE,
                scope="session",
                runtime="claude",
                session_id=session_id,
                connector_id=context.connector_id,
                supported=True,
                available=not active,
                unavailable_reason="turn_active" if active else None,
                metadata={"source": "claude.runtime"},
            ),
            RuntimeCapability(
                capability_id=CAPABILITY_SESSION_INTERRUPT,
                scope="session",
                runtime="claude",
                session_id=session_id,
                connector_id=context.connector_id,
                supported=True,
                available=active,
                unavailable_reason=None if active else "no_active_turn",
                metadata={"source": "claude.runtime"},
            ),
            RuntimeCapability(
                capability_id=CAPABILITY_SESSION_INTERACTION_APPROVAL,
                scope="session",
                runtime="claude",
                session_id=session_id,
                connector_id=context.connector_id,
                supported=True,
                available=True,
                metadata={"source": "claude.runtime"},
            ),
            RuntimeCapability(
                capability_id=CAPABILITY_CATALOG_PERMISSION,
                scope="session",
                runtime="claude",
                session_id=session_id,
                connector_id=context.connector_id,
                supported=True,
                available=True,
                metadata={"source": "claude.runtime"},
            ),
        ),
        metadata={"source": "claude.runtime"},
    )
