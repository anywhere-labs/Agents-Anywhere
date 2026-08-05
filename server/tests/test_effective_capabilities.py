from __future__ import annotations

import asyncio

import pytest

from agent_server.core.capabilities import (
    SESSION_INTERRUPT,
    SESSION_SEND_MESSAGE,
    capability_is_usable,
    find_capability,
)
from agent_server.core.models import SessionView
from agent_server.core.protocol import ProtocolCapability, ProtocolCapabilitySet
from agent_server.services.effective_capabilities import (
    derive_session_effective_capabilities,
    publish_connector_session_capabilities,
)


@pytest.mark.parametrize(
    ("supported", "available", "allowed", "expected"),
    [
        (True, True, True, True),
        (False, True, True, False),
        (True, False, True, False),
        (True, True, False, False),
    ],
)
def test_capability_is_usable_requires_every_decision_flag(
    supported: bool,
    available: bool,
    allowed: bool,
    expected: bool,
) -> None:
    capability_set = ProtocolCapabilitySet(
        revision=1,
        capabilities=[
            ProtocolCapability(
                capabilityId=SESSION_INTERRUPT,
                supported=supported,
                available=available,
                allowed=allowed,
            )
        ],
    )

    assert capability_is_usable(capability_set, SESSION_INTERRUPT) is expected


def test_capability_is_usable_fails_closed_when_missing() -> None:
    assert (
        capability_is_usable(
            ProtocolCapabilitySet(revision=1),
            SESSION_SEND_MESSAGE,
        )
        is False
    )


def test_effective_capabilities_apply_session_takeover_to_allowed() -> None:
    session = _session(takeover=False)
    runtime_capabilities = ProtocolCapabilitySet(
        revision=2,
        capabilities=[
            ProtocolCapability(
                capabilityId=SESSION_SEND_MESSAGE,
                scope="session",
                runtime="codex",
                sessionId=session.id,
            ),
            ProtocolCapability(
                capabilityId=SESSION_INTERRUPT,
                scope="session",
                runtime="codex",
                sessionId=session.id,
            )
        ],
    )

    effective = derive_session_effective_capabilities(
        session=session,
        runtime_capabilities=runtime_capabilities,
    )

    send = find_capability(effective, SESSION_SEND_MESSAGE)
    interrupt = find_capability(effective, SESSION_INTERRUPT)
    assert send is not None
    assert send.available is True
    assert send.allowed is False
    assert send.unavailableReason == "session_not_taken_over"
    assert interrupt is not None
    assert interrupt.allowed is False


def test_effective_capabilities_use_runtime_session_fact_not_session_status() -> None:
    session = _session(takeover=True)
    session = session.model_copy(update={"status": "idle"})
    runtime_capabilities = ProtocolCapabilitySet(
        revision=4,
        capabilities=[
            ProtocolCapability(
                capabilityId=SESSION_SEND_MESSAGE,
                scope="session",
                runtime="codex",
                sessionId=session.id,
                available=False,
                unavailableReason="runtime_turn_running",
            ),
            ProtocolCapability(
                capabilityId=SESSION_INTERRUPT,
                scope="session",
                runtime="codex",
                sessionId=session.id,
                available=True,
            ),
        ],
    )

    effective = derive_session_effective_capabilities(
        session=session,
        runtime_capabilities=runtime_capabilities,
    )

    send = find_capability(effective, SESSION_SEND_MESSAGE)
    interrupt = find_capability(effective, SESSION_INTERRUPT)
    assert send is not None
    assert send.available is False
    assert send.unavailableReason == "runtime_turn_running"
    assert interrupt is not None
    assert interrupt.available is True


def test_unknown_runtime_capability_is_preserved_but_not_promoted() -> None:
    unknown_capability_id = "vendor.example.future_action"
    runtime_capabilities = ProtocolCapabilitySet(
        revision=3,
        capabilities=[
            ProtocolCapability(
                capabilityId=unknown_capability_id,
                runtime="codex",
                parameters={"extension": {"enabled": True}},
            )
        ],
    )

    dumped = runtime_capabilities.model_dump(mode="json")
    assert dumped["capabilities"][0]["capabilityId"] == unknown_capability_id
    assert dumped["capabilities"][0]["parameters"] == {
        "extension": {"enabled": True}
    }

    effective = derive_session_effective_capabilities(
        session=_session(takeover=True),
        runtime_capabilities=runtime_capabilities,
    )
    assert find_capability(effective, unknown_capability_id) is None


def test_presence_change_publishes_reprojected_session_capabilities() -> None:
    session = _session(takeover=True)

    class Repository:
        async def list_sessions_for_connector(
            self, connector_id: str
        ) -> list[SessionView]:
            assert connector_id == session.connectorId
            return [session]

        async def get_protocol_capabilities(
            self,
            connector_id: str,
            *,
            user_id: str | None = None,
        ) -> dict:
            assert connector_id == session.connectorId
            assert user_id is None
            return {
                "revision": 1,
                "capabilities": [
                    {
                        "capabilityId": SESSION_SEND_MESSAGE,
                        "version": "1",
                        "scope": "session",
                        "runtime": "codex",
                        "sessionId": session.id,
                        "supported": True,
                        "available": True,
                        "allowed": True,
                        "unavailableReason": None,
                        "parameters": {},
                    }
                ],
            }

        async def get_session_seq(self, session_id: str) -> int:
            assert session_id == session.id
            return 7

    class OfflinePresence:
        async def is_online(self, connector_id: str) -> bool:
            assert connector_id == session.connectorId
            return False

    class Publisher:
        def __init__(self) -> None:
            self.payloads: list[tuple[str, dict]] = []

        async def publish(self, session_id: str, payload: dict) -> None:
            self.payloads.append((session_id, payload))

    publisher = Publisher()
    asyncio.run(
        publish_connector_session_capabilities(
            Repository(),
            OfflinePresence(),
            publisher,
            session.connectorId,
        )
    )

    assert len(publisher.payloads) == 1
    session_id, payload = publisher.payloads[0]
    assert session_id == session.id
    assert payload["nextSeq"] == 7
    assert payload["session"]["connectorStatus"] == "offline"
    capabilities = {
        item["capabilityId"]: item
        for item in payload["capabilitySet"]["capabilities"]
    }
    assert capabilities[SESSION_SEND_MESSAGE]["available"] is False
    assert capabilities[SESSION_SEND_MESSAGE]["unavailableReason"] == "connector_offline"


def _session(*, takeover: bool) -> SessionView:
    return SessionView(
        id="session-1",
        connectorId="connector-1",
        connectorStatus="online",
        runtime="codex",
        status="idle",
        takeover=takeover,
        updatedSeq=1,
    )
