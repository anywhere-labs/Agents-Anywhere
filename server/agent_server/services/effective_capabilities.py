from __future__ import annotations

from typing import Any, Protocol

from agent_server.core.capabilities import (
    CATALOG_EFFORT,
    CATALOG_MODEL,
    CATALOG_PERMISSION,
    RUNTIME_ATTACHMENT,
    RUNTIME_CONFIG,
    SESSION_INTERACTION_APPROVAL,
    SESSION_INTERRUPT,
    SESSION_SEND_MESSAGE,
    SESSION_STEER,
)
from agent_server.core.models import SessionView
from agent_server.core.protocol import ProtocolCapability, ProtocolCapabilitySet
from agent_server.services.connector_presence import (
    ConnectorPresencePort,
    with_effective_session_connector_status,
)

_INHERITED_RUNTIME_CAPABILITY_IDS = (
    SESSION_SEND_MESSAGE,
    SESSION_INTERRUPT,
    SESSION_STEER,
    SESSION_INTERACTION_APPROVAL,
    RUNTIME_ATTACHMENT,
    RUNTIME_CONFIG,
    CATALOG_MODEL,
    CATALOG_PERMISSION,
    CATALOG_EFFORT,
)


class SessionCapabilityRepository(Protocol):
    async def get_protocol_capabilities(
        self,
        connector_id: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]: ...

    async def get_session_seq(self, session_id: str) -> int: ...

    async def list_sessions_for_connector(
        self,
        connector_id: str,
    ) -> list[SessionView]: ...


class SessionCapabilityPublisher(Protocol):
    async def publish(self, session_id: str, payload: dict[str, Any]) -> None: ...


async def project_session_capabilities(
    store: SessionCapabilityRepository,
    presence: ConnectorPresencePort,
    session: SessionView,
    *,
    user_id: str | None = None,
) -> tuple[SessionView, ProtocolCapabilitySet, ProtocolCapabilitySet]:
    session = await with_effective_session_connector_status(presence, session)
    runtime_capabilities = ProtocolCapabilitySet.model_validate(
        await store.get_protocol_capabilities(
            session.connectorId,
            user_id=user_id,
        )
    )
    effective_capabilities = derive_session_effective_capabilities(
        session=session,
        runtime_capabilities=runtime_capabilities,
    )
    return session, runtime_capabilities, effective_capabilities


async def publish_connector_session_capabilities(
    store: SessionCapabilityRepository,
    presence: ConnectorPresencePort,
    publisher: SessionCapabilityPublisher,
    connector_id: str,
) -> None:
    for session in await store.list_sessions_for_connector(connector_id):
        session, _runtime_capabilities, effective_capabilities = (
            await project_session_capabilities(store, presence, session)
        )
        await publisher.publish(
            session.id,
            {
                "sessionId": session.id,
                "nextSeq": await store.get_session_seq(session.id),
                "session": session.model_dump(mode="json"),
                "capabilitySet": effective_capabilities.model_dump(mode="json"),
            },
        )


def derive_session_effective_capabilities(
    *,
    session: SessionView,
    runtime_capabilities: ProtocolCapabilitySet,
) -> ProtocolCapabilitySet:
    session_by_id = {
        capability.capabilityId: capability
        for capability in runtime_capabilities.capabilities
        if capability.runtime == session.runtime
        and capability.scope == "session"
        and capability.sessionId == session.id
    }
    runtime_by_id = {
        capability.capabilityId: capability
        for capability in runtime_capabilities.capabilities
        if capability.runtime == session.runtime and capability.scope == "runtime"
    }
    online = session.connectorStatus == "online"
    capabilities: list[ProtocolCapability] = []
    for capability_id in _INHERITED_RUNTIME_CAPABILITY_IDS:
        source_capability = session_by_id.get(capability_id)
        if source_capability is None:
            source_capability = runtime_by_id.get(capability_id)
        capabilities.append(
            platform_scoped_session_capability(
                session,
                capability_id,
                source_capability,
                online=online,
            )
        )
    return ProtocolCapabilitySet(
        revision=effective_capability_revision(session, runtime_capabilities),
        capabilities=capabilities,
    )


def platform_scoped_session_capability(
    session: SessionView,
    capability_id: str,
    source_capability: ProtocolCapability | None,
    online: bool,
) -> ProtocolCapability:
    supported = source_capability.supported if source_capability is not None else False
    runtime_available = (
        source_capability.available if source_capability is not None else False
    )
    runtime_allowed = source_capability.allowed if source_capability is not None else True
    available = supported and runtime_available and online
    allowed = runtime_allowed and session.takeover
    unavailable_reason = platform_unavailable_reason(
        source_capability,
        supported,
        available,
        allowed,
        online,
        session.takeover,
    )
    return ProtocolCapability(
        capabilityId=capability_id,
        scope="session",
        runtime=session.runtime,
        sessionId=session.id,
        supported=supported,
        available=available,
        allowed=allowed,
        unavailableReason=unavailable_reason,
        parameters=source_capability.parameters if source_capability is not None else {},
    )


def effective_capability_revision(
    session: SessionView,
    runtime_capabilities: ProtocolCapabilitySet,
) -> int:
    return max(int(session.updatedSeq or 0), int(runtime_capabilities.revision))


def platform_unavailable_reason(
    capability: ProtocolCapability | None,
    supported: bool,
    available: bool,
    allowed: bool,
    online: bool,
    takeover: bool,
) -> str | None:
    if not supported:
        return "runtime_capability_unsupported"
    if not online:
        return "connector_offline"
    if not takeover and not allowed:
        return "session_not_taken_over"
    if available and allowed:
        return None
    if capability is not None and capability.unavailableReason:
        return capability.unavailableReason
    if not available:
        return "runtime_capability_unavailable"
    return None
