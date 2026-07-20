from __future__ import annotations

from connector.protocol import (
    PROTOCOL_VERSION_1,
    ProtocolCapability,
    ProtocolCapabilitySet,
    ProtocolModelCatalog,
    ProtocolModelItem,
    ProtocolPermissionCatalog,
    ProtocolPermissionItem,
    ProtocolReasoningItem,
    RpcNotification,
    protocol_selection_id,
)


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


def test_connector_model_catalog_shape() -> None:
    selection_id = protocol_selection_id(
        "codex",
        "model",
        {"model_id": "gpt-5.5", "reasoning_id": "xhigh"},
    )
    catalog = ProtocolModelCatalog(
        runtime="codex",
        revision=1,
        models=[
            ProtocolModelItem(
                displayName="GPT-5.5",
                id="gpt-5.5",
                reasoningItems=[
                    ProtocolReasoningItem(
                        displayName="Extra high",
                        id="xhigh",
                        fullModelId="gpt-5.5",
                        selectionId=selection_id,
                    )
                ],
            )
        ],
    )

    dumped = catalog.model_dump(mode="json")

    assert dumped["models"][0]["selectionId"] is None
    assert dumped["models"][0]["reasoningItems"][0]["selectionId"] == selection_id


def test_connector_permission_catalog_shape() -> None:
    selection_id = protocol_selection_id(
        "codex",
        "permission",
        {"permission_mode": "fullAccess"},
    )
    catalog = ProtocolPermissionCatalog(
        runtime="codex",
        revision=1,
        permissions=[
            ProtocolPermissionItem(
                displayName="Full access",
                id="fullAccess",
                selectionId=selection_id,
            )
        ],
    )

    dumped = catalog.model_dump(mode="json")

    assert dumped["permissions"][0]["selectionId"] == selection_id
