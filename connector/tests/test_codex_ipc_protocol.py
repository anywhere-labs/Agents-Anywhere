from __future__ import annotations

import pytest
from pydantic import ValidationError

from connector.codex.ipc_protocol import (
    CODEX_IPC_COORDINATION_BROADCAST_ADAPTER,
    CODEX_IPC_ROUTER_MESSAGE_ADAPTER,
    CodexIpcClientDiscoveryRequest,
    CodexIpcFollowerStartTurnParams,
    CodexIpcFollowerSteerTurnParams,
    CodexIpcInitializeParams,
    CodexIpcInitializeRequest,
    CodexIpcPatchesChange,
    CodexIpcRequest,
    CodexIpcSnapshotChange,
    CodexIpcStreamStateChangedBroadcast,
    codex_ipc_method_version,
)


def _conversation_state() -> dict:
    return {
        "id": "thr_1",
        "hostId": "local",
        "cwd": "/repo",
        "title": "IPC task",
        "turns": [],
        "turnHistory": {
            "kind": "canonical",
            "history": {
                "generation": 1,
                "isComplete": True,
                "entitiesByKey": {
                    "tail:1:local:turn_1": {
                        "turnId": "turn_1",
                        "status": "inProgress",
                        "items": [
                            {"id": "msg_1", "type": "agentMessage", "text": "hel"},
                        ],
                    }
                },
                "islands": [
                    {
                        "id": "tail:1",
                        "entries": [
                            {
                                "key": "tail:1:local:turn_1",
                                "value": "tail:1:local:turn_1",
                            }
                        ],
                        "olderBoundary": {
                            "status": "exhausted",
                            "boundaryId": "tail:1:older",
                        },
                        "newerBoundary": {
                            "status": "exhausted",
                            "boundaryId": "tail:1:newer",
                        },
                    }
                ],
            },
        },
        "futureUiField": {"preserved": True},
    }


def test_initialize_request_matches_codex_router_shape() -> None:
    request = CodexIpcInitializeRequest(
        requestId="req_1",
        params=CodexIpcInitializeParams(clientType="agents-anywhere"),
    )

    assert request.model_dump(mode="json", exclude_none=True) == {
        "type": "request",
        "requestId": "req_1",
        "sourceClientId": "initializing-client",
        "method": "initialize",
        "params": {"clientType": "agents-anywhere"},
        "version": 0,
    }


def test_router_message_discriminates_client_discovery_request() -> None:
    message = CODEX_IPC_ROUTER_MESSAGE_ADAPTER.validate_python(
        {
            "type": "client-discovery-request",
            "requestId": "discovery_1",
            "request": {
                "type": "request",
                "requestId": "request_1",
                "sourceClientId": "client_1",
                "method": "thread-follower-load-complete-history",
                "params": {"conversationId": "thr_1"},
                "version": 1,
            },
        }
    )

    assert isinstance(message, CodexIpcClientDiscoveryRequest)
    assert isinstance(message.request, CodexIpcRequest)
    assert message.request.params["conversationId"] == "thr_1"


def test_stream_snapshot_parses_canonical_history_and_preserves_additive_fields() -> (
    None
):
    message = CODEX_IPC_COORDINATION_BROADCAST_ADAPTER.validate_python(
        {
            "type": "broadcast",
            "method": "thread-stream-state-changed",
            "sourceClientId": "owner_1",
            "targetClientIds": ["follower_1"],
            "version": 11,
            "params": {
                "conversationId": "thr_1",
                "hostId": "local",
                "change": {
                    "type": "snapshot",
                    "revision": 3,
                    "conversationState": _conversation_state(),
                },
            },
        }
    )

    assert isinstance(message, CodexIpcStreamStateChangedBroadcast)
    assert isinstance(message.params.change, CodexIpcSnapshotChange)
    history = message.params.change.conversationState.turnHistory
    assert history is not None
    assert (
        history.history.entitiesByKey["tail:1:local:turn_1"].items[0].type
        == "agentMessage"
    )
    dumped = message.params.change.conversationState.model_dump(mode="json")
    assert dumped["futureUiField"] == {"preserved": True}


def test_stream_patch_models_token_level_full_text_replacement() -> None:
    change = CodexIpcPatchesChange.model_validate(
        {
            "type": "patches",
            "baseRevision": 8,
            "revision": 9,
            "patches": [
                {
                    "op": "replace",
                    "path": [
                        "turnHistory",
                        "history",
                        "entitiesByKey",
                        "tail:1:local:turn_1",
                        "items",
                        0,
                        "text",
                    ],
                    "value": "hello",
                }
            ],
        }
    )

    assert change.patches[0].path[-2:] == [0, "text"]
    assert change.patches[0].value == "hello"  # type: ignore[union-attr]


def test_stream_patch_rejects_revision_gap() -> None:
    with pytest.raises(ValidationError, match="advance by exactly one"):
        CodexIpcPatchesChange.model_validate(
            {
                "type": "patches",
                "baseRevision": 8,
                "revision": 10,
                "patches": [],
            }
        )


def test_stream_snapshot_rejects_mismatched_conversation_id() -> None:
    with pytest.raises(ValidationError, match="does not match"):
        CodexIpcStreamStateChangedBroadcast.model_validate(
            {
                "sourceClientId": "owner_1",
                "params": {
                    "conversationId": "thr_other",
                    "change": {
                        "type": "snapshot",
                        "revision": 1,
                        "conversationState": _conversation_state(),
                    },
                },
            }
        )


def test_known_method_versions_match_recovered_extension_contract() -> None:
    assert codex_ipc_method_version("thread-stream-state-changed") == 11
    assert codex_ipc_method_version("thread-follower-interrupt-turn") == 3
    assert codex_ipc_method_version("client-status-changed") == 0


def test_follower_steer_params_match_recovered_extension_contract() -> None:
    params = CodexIpcFollowerSteerTurnParams.model_validate(
        {
            "conversationId": "thr_1",
            "clientUserMessageId": "msg_1",
            "input": [{"type": "text", "text": "focus", "text_elements": []}],
            "attachments": [],
            "additionalContext": {"selection": "tests"},
        }
    )

    assert params.conversationId == "thr_1"
    assert params.input[0]["text"] == "focus"
    assert codex_ipc_method_version("thread-follower-steer-turn") == 1


def test_follower_start_params_match_recovered_extension_contract() -> None:
    params = CodexIpcFollowerStartTurnParams.model_validate(
        {
            "conversationId": "thr_1",
            "turnStartParams": {
                "input": [
                    {"type": "text", "text": "start", "text_elements": []}
                ],
                "clientUserMessageId": "msg_1",
                "model": "gpt-5",
                "effort": "high",
            },
        }
    )

    assert params.turnStartParams.input[0]["text"] == "start"
    assert params.turnStartParams.clientUserMessageId == "msg_1"
    assert params.turnStartParams.attachments == []
    assert params.turnStartParams.commentAttachments == []
    assert params.turnStartParams.runtimeWorkspaceRoots == []
    assert codex_ipc_method_version("thread-follower-start-turn") == 1
