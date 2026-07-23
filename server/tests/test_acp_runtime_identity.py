from __future__ import annotations

import pytest
from pydantic import ValidationError

from agent_server.core.models import ApprovalIn, SessionCreateRequest, TimelineItemIn
from agent_server.core.runtime_config import default_runtime_settings
from agent_server.infra.runtimes.serializers import serializer_for_runtime


def test_timeline_item_accepts_acp_runtime_ids() -> None:
    for runtime in ("gemini", "cursor", "codebuddy", "grok_build"):
        item = TimelineItemIn.model_validate(
            {
                "id": f"tl_{runtime}_1",
                "sessionId": "sess_1",
                "type": "message",
                "status": "done",
                "role": "assistant",
                "content": {"text": "hi", "format": "markdown"},
                "source": {"runtime": runtime, "itemId": "msg_1"},
                "orderSeq": 1,
                "contentHash": f"sha256:{runtime}",
            }
        )
        assert item.source.runtime == runtime


def test_approval_accepts_acp_runtime_ids() -> None:
    approval = ApprovalIn.model_validate(
        {
            "id": "appr_1",
            "sessionId": "sess_1",
            "title": "Allow tool",
            "choices": ["approve", "reject"],
            "source": {"runtime": "gemini", "requestId": 7},
        }
    )
    assert approval.source.runtime == "gemini"


def test_default_settings_and_serializer_for_unknown_acp_runtime() -> None:
    # Seeded ACP runtimes have empty model defaults (user picks in UI).
    assert default_runtime_settings("gemini") == {
        "permissionMode": None,
        "model": None,
        "effort": None,
    }
    # Completely unknown agents still get {}.
    assert default_runtime_settings("some_future_agent") == {}
    payload = serializer_for_runtime("gemini").serialize(
        settings={"model": "gemini-2.5-pro"},
        cwd="/repo",
    )
    assert payload["model"] == "gemini-2.5-pro"
    assert payload["cwd"] == "/repo"


def test_runtime_name_rejects_invalid_ids() -> None:
    for bad in ("", "Gemini", "has space", "a" * 65, "1bad", "bad-id"):
        with pytest.raises(ValidationError):
            SessionCreateRequest.model_validate(
                {
                    "connectorId": "conn_1",
                    "runtime": bad,
                    "title": "t",
                    "cwd": "/repo",
                }
            )


def test_runtime_name_accepts_snake_case() -> None:
    req = SessionCreateRequest.model_validate(
        {
            "connectorId": "conn_1",
            "runtime": "grok_build",
            "title": "t",
            "cwd": "/repo",
        }
    )
    assert req.runtime == "grok_build"
