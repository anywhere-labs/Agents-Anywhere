from __future__ import annotations

from dataclasses import dataclass

from connector.runtime_protocol import (
    CAPABILITY_CATALOG_EFFORT,
    CAPABILITY_CATALOG_MODEL,
    CAPABILITY_CATALOG_PERMISSION,
    CAPABILITY_RUNTIME_CONFIG,
    CAPABILITY_SESSION_COMMANDS,
    CAPABILITY_SESSION_INTERACTION_APPROVAL,
    CAPABILITY_SESSION_INTERRUPT,
    CAPABILITY_SESSION_SEND_MESSAGE,
    CAPABILITY_SESSION_STEER,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeStatus,
    SessionState,
)

CODEX_RUNTIME = "codex"

ACTIVE_TURN_STATUSES: tuple[RuntimeStatus, ...] = (
    "waiting",
    "running",
    "blocked",
)


@dataclass(frozen=True, slots=True)
class CodexCapabilityContext:
    connector_id: str
    revision: int
    client_available: bool
    session_id: str | None = None
    external_session_id: str | None = None
    status: RuntimeStatus = "idle"
    has_active_turn: bool = False


def codex_runtime_capabilities(context: CodexCapabilityContext) -> RuntimeCapabilitySet:
    return RuntimeCapabilitySet(
        runtime=CODEX_RUNTIME,
        revision=context.revision,
        connector_id=context.connector_id,
        capabilities=(
            runtime_capability(
                context,
                capability_id=CAPABILITY_RUNTIME_CONFIG,
                available=True,
            ),
            runtime_capability(
                context,
                capability_id=CAPABILITY_CATALOG_MODEL,
                available=context.client_available,
                unavailable_reason=client_unavailable_reason(context),
            ),
            runtime_capability(
                context,
                capability_id=CAPABILITY_CATALOG_PERMISSION,
                available=True,
            ),
            runtime_capability(
                context,
                capability_id=CAPABILITY_CATALOG_EFFORT,
                available=context.client_available,
                unavailable_reason=client_unavailable_reason(context),
            ),
        ),
        metadata={"source": "codex.capabilities.runtime"},
    )


def codex_session_capabilities(context: CodexCapabilityContext) -> RuntimeCapabilitySet:
    send_available = session_can_send_message(context)
    interrupt_available = session_can_interrupt(context)
    steer_available = session_can_steer(context)
    return RuntimeCapabilitySet(
        runtime=CODEX_RUNTIME,
        revision=context.revision,
        session_id=context.session_id,
        connector_id=context.connector_id,
        capabilities=(
            session_capability(
                context,
                capability_id=CAPABILITY_SESSION_SEND_MESSAGE,
                available=send_available,
                unavailable_reason=session_action_unavailable_reason(context),
            ),
            session_capability(
                context,
                capability_id=CAPABILITY_SESSION_INTERRUPT,
                available=interrupt_available,
                unavailable_reason=active_turn_unavailable_reason(context),
            ),
            session_capability(
                context,
                capability_id=CAPABILITY_SESSION_STEER,
                available=steer_available,
                unavailable_reason=steer_unavailable_reason(context),
            ),
            session_capability(
                context,
                capability_id=CAPABILITY_SESSION_INTERACTION_APPROVAL,
                available=session_loaded(context),
                unavailable_reason=session_unloaded_reason(context),
            ),
            session_capability(
                context,
                capability_id=CAPABILITY_SESSION_COMMANDS,
                supported=False,
                available=False,
                unavailable_reason="unsupported",
            ),
            session_capability(
                context,
                capability_id=CAPABILITY_CATALOG_MODEL,
                available=context.client_available,
                unavailable_reason=client_unavailable_reason(context),
            ),
            session_capability(
                context,
                capability_id=CAPABILITY_CATALOG_PERMISSION,
                available=True,
            ),
            session_capability(
                context,
                capability_id=CAPABILITY_CATALOG_EFFORT,
                available=context.client_available,
                unavailable_reason=client_unavailable_reason(context),
            ),
        ),
        metadata={"source": "codex.capabilities.session"},
    )


def codex_capability_context(
    connector_id: str,
    revision: int,
    client_available: bool,
    session_id: str | None = None,
    external_session_id: str | None = None,
    state: SessionState | None = None,
    has_active_turn: bool = False,
) -> CodexCapabilityContext:
    status = state.status if state is not None else "idle"
    resolved_external_session_id = (
        state.external_session_id if state is not None else external_session_id
    )
    return CodexCapabilityContext(
        connector_id=connector_id,
        revision=revision,
        client_available=client_available,
        session_id=session_id,
        external_session_id=resolved_external_session_id,
        status=status,
        has_active_turn=has_active_turn,
    )


def runtime_capability(
    context: CodexCapabilityContext,
    capability_id: str,
    available: bool,
    unavailable_reason: str | None = None,
) -> RuntimeCapability:
    return RuntimeCapability(
        capability_id=capability_id,
        scope="runtime",
        runtime=CODEX_RUNTIME,
        connector_id=context.connector_id,
        available=available,
        unavailable_reason=unavailable_reason,
    )


def session_capability(
    context: CodexCapabilityContext,
    capability_id: str,
    available: bool,
    unavailable_reason: str | None = None,
    supported: bool = True,
) -> RuntimeCapability:
    return RuntimeCapability(
        capability_id=capability_id,
        scope="session",
        runtime=CODEX_RUNTIME,
        session_id=context.session_id,
        connector_id=context.connector_id,
        supported=supported,
        available=available,
        unavailable_reason=unavailable_reason,
    )


def session_can_send_message(context: CodexCapabilityContext) -> bool:
    return session_loaded(context) and context.status == "idle"


def session_can_interrupt(context: CodexCapabilityContext) -> bool:
    if not session_loaded(context):
        return False
    if not context.has_active_turn:
        return False
    return context.status in ACTIVE_TURN_STATUSES


def session_can_steer(context: CodexCapabilityContext) -> bool:
    return (
        session_loaded(context)
        and context.has_active_turn
        and context.status == "running"
    )


def session_loaded(context: CodexCapabilityContext) -> bool:
    return context.client_available and context.external_session_id is not None


def client_unavailable_reason(context: CodexCapabilityContext) -> str | None:
    if context.client_available:
        return None
    return "codex_unavailable"


def session_unloaded_reason(context: CodexCapabilityContext) -> str | None:
    if not context.client_available:
        return "codex_unavailable"
    if context.external_session_id is None:
        return "session_unloaded"
    return None


def session_action_unavailable_reason(context: CodexCapabilityContext) -> str | None:
    unloaded_reason = session_unloaded_reason(context)
    if unloaded_reason is not None:
        return unloaded_reason
    if context.status == "idle":
        return None
    return f"session_{context.status}"


def active_turn_unavailable_reason(context: CodexCapabilityContext) -> str | None:
    unloaded_reason = session_unloaded_reason(context)
    if unloaded_reason is not None:
        return unloaded_reason
    if not context.has_active_turn:
        return "no_active_turn"
    if context.status in ACTIVE_TURN_STATUSES:
        return None
    return f"session_{context.status}"


def steer_unavailable_reason(context: CodexCapabilityContext) -> str | None:
    active_turn_reason = active_turn_unavailable_reason(context)
    if active_turn_reason is not None:
        return active_turn_reason
    if context.status != "running":
        return f"session_{context.status}"
    return None
