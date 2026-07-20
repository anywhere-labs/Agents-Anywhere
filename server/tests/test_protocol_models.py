from __future__ import annotations

from agent_server.core.protocol import (
    PROTOCOL_VERSION_1,
    ProtocolCapability,
    ProtocolCapabilitySet,
    ProtocolHandshakeResponse,
    protocol_selection_id,
)


def test_protocol_capability_set_uses_wire_field_names() -> None:
    capability_set = ProtocolCapabilitySet(
        revision=1,
        capabilities=[
            ProtocolCapability(
                capabilityId="session.interrupt",
                scope="runtime",
                runtime="codex",
                parameters={"source": "discovery"},
            )
        ],
    )

    dumped = capability_set.model_dump(mode="json")

    assert dumped["revision"] == 1
    assert dumped["capabilities"][0]["capabilityId"] == "session.interrupt"
    assert dumped["capabilities"][0]["runtime"] == "codex"


def test_protocol_handshake_response_selects_v1() -> None:
    response = ProtocolHandshakeResponse(selectedProtocolVersion=PROTOCOL_VERSION_1, serverVersion="0.2.0")

    assert response.selectedProtocolVersion == "1.0"


def test_protocol_selection_id_is_stable_and_identity_based() -> None:
    first = protocol_selection_id(
        "codex",
        "model",
        {"model_id": "gpt-5.5", "reasoning_id": "xhigh"},
    )
    second = protocol_selection_id(
        "codex",
        "model",
        {"reasoning_id": "xhigh", "model_id": "gpt-5.5"},
    )
    different = protocol_selection_id(
        "codex",
        "model",
        {"model_id": "gpt-5.5", "reasoning_id": "high"},
    )

    assert first == second
    assert first.startswith("sel_model_")
    assert first != different
