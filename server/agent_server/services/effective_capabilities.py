from __future__ import annotations

from typing import Any

from agent_server.core.models import SessionView
from agent_server.core.protocol import ProtocolCapability, ProtocolCapabilitySet


_INHERITED_RUNTIME_CAPABILITY_IDS = (
    "session.interrupt",
    "session.steer",
    "session.interaction.approval",
    "runtime.config",
    "catalog.model",
    "catalog.permission",
    "catalog.effort",
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
            "session.send_message",
            supported=True,
            available=online and session.status == "idle",
            unavailable_reason=_reason_for_send_message(session, online),
        )
    ]
    for capability_id in _INHERITED_RUNTIME_CAPABILITY_IDS:
        runtime_capability = runtime_by_id.get(capability_id)
        supported = runtime_capability.supported if runtime_capability is not None else False
        runtime_available = runtime_capability.available if runtime_capability is not None else False
        runtime_allowed = runtime_capability.allowed if runtime_capability is not None else True
        available = supported and runtime_available and online
        unavailable_reason = _runtime_capability_unavailable_reason(
            runtime_capability,
            supported=supported,
            available=available,
            online=online,
        )
        if capability_id == "session.interrupt":
            status_available = session.status in {"running", "waiting_approval"}
            available = available and status_available
            if unavailable_reason is None and not status_available:
                unavailable_reason = "session_not_interruptible"
        elif capability_id == "session.steer":
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
                allowed=runtime_allowed,
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
