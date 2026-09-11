from __future__ import annotations

from contextlib import AbstractAsyncContextManager
from typing import Any, Protocol
from weakref import WeakKeyDictionary

from agent_server.core.capabilities import (
    CATALOG_EFFORT,
    CATALOG_MODEL,
    CATALOG_PERMISSION,
    RUNTIME_ATTACHMENT,
    RUNTIME_CONFIG,
    SESSION_COMMANDS,
    SESSION_INTERACTION_APPROVAL,
    SESSION_INTERRUPT,
    SESSION_SEND_MESSAGE,
    SESSION_STEER,
)
from agent_server.core.models import SessionView
from agent_server.core.protocol import ProtocolCapability, ProtocolCapabilitySet
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.services.connector_presence import (
    ConnectorPresencePort,
    with_effective_session_connector_status,
)

# A newer local publication supersedes unfinished work for the same connector.
# Entries live only while a publication is active; no capability payload is cached.
_ACTIVE_PUBLICATIONS: WeakKeyDictionary[Any, dict[str, object]] = WeakKeyDictionary()


_INHERITED_RUNTIME_CAPABILITY_IDS = (
    SESSION_SEND_MESSAGE,
    SESSION_INTERRUPT,
    SESSION_STEER,
    SESSION_INTERACTION_APPROVAL,
    SESSION_COMMANDS,
    RUNTIME_ATTACHMENT,
    RUNTIME_CONFIG,
    CATALOG_MODEL,
    CATALOG_PERMISSION,
    CATALOG_EFFORT,
)


class SessionCapabilityRepository(Protocol):
    def session_revision_fence(
        self,
        session_id: str,
    ) -> AbstractAsyncContextManager[None]: ...

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


async def read_session_capability_facts(
    manager: ConnectorRpcManager,
    session: SessionView,
    *,
    runtime_id: str,
) -> ProtocolCapabilitySet:
    """Use the same live facts for displayed capabilities and action admission."""
    params: dict[str, Any] = {
        "sessionId": session.id,
        "runtime": session.runtime,
        "runtimeId": runtime_id,
    }
    if session.externalSessionId:
        params["externalSessionId"] = session.externalSessionId
    result = await manager.request(
        session.connectorId, "session.capabilities", params, timeout=10,
    )
    if not isinstance(result, dict) or not isinstance(result.get("capabilitySet"), dict):
        raise ValueError("connector did not return a capability set")
    try:
        return ProtocolCapabilitySet.model_validate(result["capabilitySet"])
    except ValueError as exc:
        raise ValueError("connector returned an invalid capability set") from exc


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
    active = _ACTIVE_PUBLICATIONS.setdefault(publisher, {})
    token = object()
    active[connector_id] = token
    try:
        sessions = await store.list_sessions_for_connector(connector_id)
        if not sessions:
            return
        runtime_capabilities = ProtocolCapabilitySet.model_validate(
            await store.get_protocol_capabilities(connector_id)
        )
        index = SessionCapabilityIndex(runtime_capabilities)
        for session in sessions:
            if active.get(connector_id) is not token:
                return
            async with store.session_revision_fence(session.id):
                session = await with_effective_session_connector_status(presence, session)
                effective_capabilities = index.project(session)
                next_seq = await store.get_session_seq(session.id)
                if active.get(connector_id) is not token:
                    return
                await publisher.publish(
                    session.id,
                    {
                        "sessionId": session.id,
                        "nextSeq": next_seq,
                        "session": session.model_dump(mode="json"),
                        "capabilitySet": effective_capabilities.model_dump(mode="json"),
                    },
                )
    finally:
        if active.get(connector_id) is token:
            active.pop(connector_id)
        if not active:
            _ACTIVE_PUBLICATIONS.pop(publisher, None)


class SessionCapabilityIndex:
    """Index one validated capability snapshot for many session projections."""

    def __init__(self, capability_set: ProtocolCapabilitySet) -> None:
        self.source = capability_set
        self.groups: dict[tuple, dict[str, ProtocolCapability]] = {}
        for capability in capability_set.capabilities:
            key = (
                capability.runtime,
                capability.scope,
                capability.sessionId if capability.scope == "session" else None,
                _capability_runtime_id(capability),
            )
            self.groups.setdefault(key, {})[capability.capabilityId] = capability

    def project(self, session: SessionView) -> ProtocolCapabilitySet:
        groups = [self.groups.get(key, {}) for key in (
            (session.runtime, "session", session.id, session.runtimeId),
            (session.runtime, "session", session.id, None),
            (session.runtime, "runtime", None, session.runtimeId),
            (session.runtime, "runtime", None, None),
        )]
        capabilities = []
        for capability_id in _INHERITED_RUNTIME_CAPABILITY_IDS:
            source = next((group[capability_id] for group in groups
                           if capability_id in group), None)
            capabilities.append(platform_scoped_session_capability(
                session, capability_id, source,
                online=session.connectorStatus == "online",
            ))
        return ProtocolCapabilitySet(
            revision=effective_capability_revision(session, self.source),
            capabilities=capabilities,
        )


def derive_session_effective_capabilities(
    *,
    session: SessionView,
    runtime_capabilities: ProtocolCapabilitySet,
) -> ProtocolCapabilitySet:
    return SessionCapabilityIndex(runtime_capabilities).project(session)


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
        runtimeId=session.runtimeId,
        sessionId=session.id,
        supported=supported,
        available=available,
        allowed=allowed,
        unavailableReason=unavailable_reason,
        parameters=source_capability.parameters if source_capability is not None else {},
        metadata=getattr(source_capability, "metadata", {}),
    )


def _capability_runtime_id(capability: ProtocolCapability) -> str | None:
    value = getattr(capability, "runtimeId", None)
    return value if isinstance(value, str) and value else None


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
