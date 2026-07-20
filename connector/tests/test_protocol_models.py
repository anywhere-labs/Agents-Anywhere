from __future__ import annotations

from connector.protocol import PROTOCOL_VERSION_1, ProtocolCapability, ProtocolCapabilitySet, RpcNotification


def test_connector_protocol_capability_set_round_trip() -> None:
    capability_set = ProtocolCapabilitySet(
        revision=7,
        capabilities=[
            ProtocolCapability(
                capabilityId="session.interaction.approval",
                runtime="codex",
                parameters={"supports_allow_once": True},
            )
        ],
    )

    assert capability_set.capabilities[0].capabilityId == "session.interaction.approval"
    assert capability_set.model_dump(mode="json")["capabilities"][0]["parameters"]["supports_allow_once"] is True


def test_existing_rpc_notification_shape_is_preserved() -> None:
    notification = RpcNotification(method="protocol.capabilitiesUpdated", params={"revision": 1})

    assert notification.type == "notification"
    assert notification.method == "protocol.capabilitiesUpdated"
    assert PROTOCOL_VERSION_1 == "1.0"
