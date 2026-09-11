from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

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


def test_effective_capabilities_prefer_the_exact_runtime_instance() -> None:
    session = _session(takeover=True).model_copy(
        update={"runtimeId": "rti_work"}
    )
    runtime_capabilities = ProtocolCapabilitySet(
        revision=5,
        capabilities=[
            ProtocolCapability(
                capabilityId=SESSION_SEND_MESSAGE,
                scope="runtime",
                runtime="codex",
                available=False,
                unavailableReason="provider_default_disabled",
            ),
            ProtocolCapability.model_validate(
                {
                    "capabilityId": SESSION_SEND_MESSAGE,
                    "scope": "runtime",
                    "runtime": "codex",
                    "runtimeId": "rti_other",
                    "available": False,
                    "unavailableReason": "other_instance_disabled",
                }
            ),
            ProtocolCapability.model_validate(
                {
                    "capabilityId": SESSION_SEND_MESSAGE,
                    "scope": "runtime",
                    "runtime": "codex",
                    "runtimeId": "rti_work",
                    "available": True,
                }
            ),
        ],
    )

    effective = derive_session_effective_capabilities(
        session=session,
        runtime_capabilities=runtime_capabilities,
    )

    send = find_capability(effective, SESSION_SEND_MESSAGE)
    assert send is not None
    assert send.available is True
    assert send.unavailableReason is None
    assert send.model_dump(mode="json")["runtimeId"] == "rti_work"


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
        @asynccontextmanager
        async def session_revision_fence(self, session_id: str):
            assert session_id == session.id
            yield

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

        async def get_protocol_capabilities_stamp(self, connector_id):
            return (1, "unchanged")

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


def test_effective_capabilities_preserve_attachment_mime_policy() -> None:
    source = ProtocolCapabilitySet(revision=1, capabilities=[ProtocolCapability(
        capabilityId="runtime.attachment", runtime="codex", scope="runtime",
        metadata={"allowedMimeTypes": ["image/png"]},
    )])
    result = derive_session_effective_capabilities(session=_session(takeover=True), runtime_capabilities=source)
    attachment = find_capability(result, "runtime.attachment")
    assert attachment is not None
    assert attachment.metadata == {"allowedMimeTypes": ["image/png"]}


def test_batch_refreshes_equal_revision_replacement_from_another_publisher():
    async def exercise():
        paused, release = asyncio.Event(), asyncio.Event()

        class Repository:
            allowed = True
            reads = 0

            async def list_sessions_for_connector(self, connector_id):
                return [
                    _session(takeover=True).model_copy(update={"id": f"session-{i}"})
                    for i in range(3)
                ]

            @asynccontextmanager
            async def session_revision_fence(self, session_id):
                if asyncio.current_task().get_name() == "old" and session_id == "session-1":
                    paused.set()
                    await release.wait()
                yield

            async def get_protocol_capabilities_stamp(self, connector_id):
                return (7, "first-write" if self.allowed else "replacement-write")

            async def get_protocol_capabilities(self, connector_id, *, user_id=None):
                self.reads += 1
                return {
                    "revision": 7,
                    "capabilities": [{
                        "capabilityId": SESSION_SEND_MESSAGE,
                        "runtime": "codex",
                        "scope": "runtime",
                        "allowed": self.allowed,
                    }],
                }

            async def get_session_seq(self, session_id):
                return 9

        class Presence:
            async def is_online(self, connector_id):
                return True

        class Publisher:
            def __init__(self):
                self.allowed = []

            async def publish(self, session_id, payload):
                self.allowed.append(next(
                    item["allowed"] for item in payload["capabilitySet"]["capabilities"]
                    if item["capabilityId"] == SESSION_SEND_MESSAGE
                ))

        store, old_publisher, new_publisher = Repository(), Publisher(), Publisher()
        old = asyncio.create_task(publish_connector_session_capabilities(
            store, Presence(), old_publisher, "connector-1",
        ), name="old")
        await paused.wait()
        store.allowed = False
        # A different publisher models a different Server process: the local
        # supersession token cannot stop the old batch in this case.
        await publish_connector_session_capabilities(
            store, Presence(), new_publisher, "connector-1",
        )
        release.set()
        await old
        assert old_publisher.allowed == [True, False, False]
        assert new_publisher.allowed == [False, False, False]
        assert store.reads == 3

    asyncio.run(exercise())


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


def test_capability_batch_reads_once_and_newer_batch_supersedes_old_work():
    async def exercise():
        started, release = asyncio.Event(), asyncio.Event()

        class Repository:
            reads = 0
            allowed = True
            pause = True

            async def list_sessions_for_connector(self, connector_id):
                return [_session(takeover=True).model_copy(update={"id": f"session-{i}"})
                        for i in range(3)]

            async def get_protocol_capabilities(self, connector_id, *, user_id=None):
                self.reads += 1
                return {"revision": self.reads, "capabilities": [{
                    "capabilityId": SESSION_SEND_MESSAGE, "scope": "runtime",
                    "runtime": "codex", "allowed": self.allowed,
                }]}

            async def get_protocol_capabilities_stamp(self, connector_id):
                return (1, "allowed" if self.allowed else "denied")

            @asynccontextmanager
            async def session_revision_fence(self, session_id):
                yield

            async def get_session_seq(self, session_id):
                if self.pause:
                    self.pause = False
                    started.set()
                    await release.wait()
                return 7

        class Presence:
            async def is_online(self, connector_id):
                return True

        class Publisher:
            def __init__(self):
                self.sent = []

            async def publish(self, session_id, payload):
                self.sent.append(payload)

        repository, publisher = Repository(), Publisher()
        old = asyncio.create_task(publish_connector_session_capabilities(
            repository, Presence(), publisher, "connector-1",
        ))
        await started.wait()
        repository.allowed = False
        await publish_connector_session_capabilities(repository, Presence(), publisher, "connector-1")
        release.set()
        await old
        assert repository.reads == 2
        assert len(publisher.sent) == 3
        assert all(next(cap for cap in payload["capabilitySet"]["capabilities"]
                        if cap["capabilityId"] == SESSION_SEND_MESSAGE)["allowed"] is False
                   for payload in publisher.sent)

    asyncio.run(exercise())
