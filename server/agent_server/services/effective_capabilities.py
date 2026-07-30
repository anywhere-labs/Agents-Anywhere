from __future__ import annotations

from typing import Any, Protocol

from agent_server.core.capabilities import (
    CATALOG_EFFORT,
    CATALOG_MODEL,
    CATALOG_PERMISSION,
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
    SESSION_INTERRUPT,
    SESSION_STEER,
    SESSION_INTERACTION_APPROVAL,
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
                "effectiveCapabilities": effective_capabilities.model_dump(
                    mode="json"
                ),
            },
        )


def derive_session_effective_capabilities(
    *,
    session: SessionView,
    runtime_capabilities: ProtocolCapabilitySet,
) -> ProtocolCapabilitySet:
    runtime_by_id = {
        capability.capabilityId: capability
        for capability in runtime_capabilities.capabilities
        if capability.runtime == session.runtime and capability.scope == "runtime"
    }
    online = session.connectorStatus == "online"
    capabilities = [
        _session_capability(
            session,
            SESSION_SEND_MESSAGE,
            supported=True,
            available=online and session.status == "idle",
            allowed=session.takeover,
            unavailable_reason=_reason_for_send_message(session, online),
        )
    ]
    for capability_id in _INHERITED_RUNTIME_CAPABILITY_IDS:
        runtime_capability = runtime_by_id.get(capability_id)
        supported = runtime_capability.supported if runtime_capability is not None else False
        runtime_available = runtime_capability.available if runtime_capability is not None else False
        runtime_allowed = runtime_capability.allowed if runtime_capability is not None else True
        allowed = runtime_allowed and session.takeover
        available = supported and runtime_available and online
        unavailable_reason = _runtime_capability_unavailable_reason(
            runtime_capability,
            supported=supported,
            available=available,
            online=online,
        )
        if capability_id == SESSION_INTERRUPT:
            status_available = session.status in {"pending", "running", "blocked"}
            available = available and status_available
            if unavailable_reason is None and not status_available:
                unavailable_reason = "session_not_interruptible"
        elif capability_id == SESSION_STEER:
            status_available = session.status == "running"
            available = available and status_available
            if unavailable_reason is None and not status_available:
                unavailable_reason = "session_not_running"
        capabilities.append(
            _session_capability(
                session,
                capability_id,
                supported=supported,
                available=available,
                allowed=allowed,
                unavailable_reason=unavailable_reason,
                parameters=runtime_capability.parameters if runtime_capability is not None else {},
            )
        )
    return ProtocolCapabilitySet(
        revision=_effective_capability_revision(session, runtime_capabilities),
        capabilities=capabilities,
    )


def _session_capability(
    session: SessionView,
    capability_id: str,
    *,
    supported: bool,
    available: bool,
    allowed: bool = True,
    unavailable_reason: str | None = None,
    parameters: dict[str, Any] | None = None,
) -> ProtocolCapability:
    return ProtocolCapability(
        capabilityId=capability_id,
        scope="session",
        runtime=session.runtime,
        sessionId=session.id,
        supported=supported,
        available=available,
        allowed=allowed,
        unavailableReason=unavailable_reason,
        parameters=parameters or {},
    )


def _effective_capability_revision(
    session: SessionView,
    runtime_capabilities: ProtocolCapabilitySet,
) -> int:
    return max(int(session.updatedSeq or 0), int(runtime_capabilities.revision))


def _reason_for_send_message(session: SessionView, online: bool) -> str | None:
    if not online:
        return "connector_offline"
    if session.status != "idle":
        return "session_not_idle"
    if not session.takeover:
        return "session_not_taken_over"
    return None


def _runtime_capability_unavailable_reason(
    capability: ProtocolCapability | None,
    *,
    supported: bool,
    available: bool,
    online: bool,
) -> str | None:
    if not supported:
        return "runtime_capability_unsupported"
    if not online:
        return "connector_offline"
    if available:
        return None
    if capability is not None and capability.unavailableReason:
        return capability.unavailableReason
    return "runtime_capability_unavailable"
