from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from connector.runtime_protocol import timeline_content_hash
from connector.runtimes.dsh.identity import (
    decode_model_selection_id,
    decode_permission_selection_id,
    model_selection_id,
    permission_selection_id,
    timeline_item_id,
)
from connector.runtimes.dsh.bridge.models import timeline_item
from connector.runtimes.session_identity import stable_runtime_session_id

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "contracts" / "dsh-bridge" / "1.0"


@pytest.mark.parametrize(
    "schema_path",
    sorted((CONTRACT / "schemas").glob("*.schema.json")),
    ids=lambda path: path.stem,
)
def test_dsh_bridge_schemas_are_valid(schema_path: Path) -> None:
    Draft202012Validator.check_schema(json.loads(schema_path.read_text()))


def test_dsh_request_fixtures() -> None:
    schema = json.loads((CONTRACT / "schemas" / "request.schema.json").read_text())
    validator = Draft202012Validator(schema)
    for path in sorted((CONTRACT / "fixtures" / "valid").glob("*.json")):
        validator.validate(json.loads(path.read_text()))
    for path in sorted((CONTRACT / "fixtures" / "invalid").glob("*.json")):
        assert not validator.is_valid(json.loads(path.read_text()))


def test_dsh_identity_fixture_matches_connector_implementations() -> None:
    fixture = json.loads((CONTRACT / "fixtures" / "identity.json").read_text())
    for item in fixture["sessionIds"]:
        assert (
            stable_runtime_session_id(
                item["connectorId"], "dsh", item["externalSessionId"]
            )
            == item["sessionId"]
        )
    for item in fixture["modelSelections"]:
        assert (
            model_selection_id(item["provider"], item["model"], item["effort"])
            == item["selectionId"]
        )
        assert decode_model_selection_id(item["selectionId"]) == (
            item["provider"],
            item["model"],
            item["effort"],
        )
    for item in fixture["permissionSelections"]:
        assert permission_selection_id(item["preset"]) == item["selectionId"]
        assert decode_permission_selection_id(item["selectionId"]) == item["preset"]
    for item in fixture["timelineIds"]:
        assert (
            timeline_item_id(
                item["externalSessionId"],
                item["projectionKind"],
                item["businessId"],
            )
            == item["itemId"]
        )
    for item in fixture["contentHashes"]:
        assert (
            timeline_content_hash(
                item["type"], item["status"], item["role"], item["content"]
            )
            == item["contentHash"]
        )


@pytest.mark.parametrize(
    "selection_id",
    [
        "wrong:model:e30",
        "dsh:model:====",
        "dsh:model:W10",
        "dsh:model:WyJhIiwiYiIsImMiLCJkIl0",
    ],
)
def test_invalid_model_selection_ids_are_rejected(selection_id: str) -> None:
    with pytest.raises(ValueError):
        decode_model_selection_id(selection_id)


def test_native_dsh_payload_timeline_item_is_adapted() -> None:
    item = timeline_item(
        {
            "id": "dsh-message",
            "type": "message",
            "orderSeq": 7,
            "revision": 1,
            "contentHash": "a" * 64,
            "payload": {
                "role": "assistant",
                "text": "hello",
                "reasoning": "brief thought",
                "messageId": "message-1",
            },
        },
        default_session_id="session-1",
    )

    assert item.type == "message"
    assert item.status == "done"
    assert item.role == "assistant"
    assert item.content == {
        "kind": "markdown",
        "format": "markdown",
        "text": "hello",
        "reasoning": "brief thought",
    }
    assert item.source["itemType"] == "message"
    assert item.source["itemId"] == "message-1"
    assert item.source["nativeContentHash"] == "a" * 64


def test_native_dsh_turn_status_is_filtered_as_turn_boundary() -> None:
    item = timeline_item(
        {
            "id": "dsh-turn",
            "type": "turn_status",
            "orderSeq": 4,
            "revision": 2,
            "contentHash": "b" * 64,
            "payload": {"turn": 1, "status": "done", "reason": {"kind": "completed"}},
        },
        default_session_id="session-1",
    )

    assert item.type == "turn.end"
    assert item.status == "done"
