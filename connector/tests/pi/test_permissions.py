from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import asdict
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtimes.pi.config import (
    default_config_values,
    normalized_config_values,
    pi_config_schema,
)
from connector.runtimes.pi.permissions import (
    APPROVAL_EXTENSION_PATH,
    APPROVAL_TITLE,
    DEFAULT_PERMISSION_MODE,
    PERMISSION_MODES,
    parse_approval_request,
    permission_items,
    validate_permission_mode,
)


def approval_record(**overrides: Any) -> dict[str, Any]:
    payload = {
        "toolName": "bash",
        "toolInput": {"command": "touch example.txt"},
        "toolCallId": "call-1",
        "cwd": "/workspace",
        "mode": "ask-writes",
        **overrides,
    }
    return {
        "id": "ui-1",
        "method": "confirm",
        "title": APPROVAL_TITLE,
        "message": json.dumps(payload),
    }


def test_permission_config_defaults_and_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PI_AA_PERMISSION_MODE", raising=False)
    assert default_config_values()["permissionMode"] == DEFAULT_PERMISSION_MODE
    assert normalized_config_values({})["permissionMode"] == "ask-writes"
    monkeypatch.setenv("PI_AA_PERMISSION_MODE", "read-only")
    assert normalized_config_values({})["permissionMode"] == "read-only"
    assert normalized_config_values({"permissionMode": "ask-all"})["permissionMode"] == "ask-all"
    assert pi_config_schema()["properties"]["permissionMode"]["enum"] == list(PERMISSION_MODES)
    monkeypatch.setenv("PI_AA_PERMISSION_MODE", "invalid")
    with pytest.raises(RuntimeInvalidRequestError, match="permissionMode"):
        normalized_config_values({})


@pytest.mark.parametrize("value", [None, 1, [], {}, "invalid", "ASK-ALL", " full-auto "])
def test_invalid_permission_mode_rejected(value: Any) -> None:
    with pytest.raises(RuntimeInvalidRequestError, match="permissionMode"):
        validate_permission_mode(value)


def test_permission_catalog_filter_and_limit() -> None:
    assert tuple(item.selection_id for item in permission_items()) == PERMISSION_MODES
    assert all(item.enabled for item in permission_items())
    assert [item.id for item in permission_items("ASK")] == ["ask-writes", "ask-all"]
    assert [item.id for item in permission_items("只读", 1)] == ["ask-writes"]
    assert permission_items(limit=0) == ()
    assert permission_items(limit=-1) == ()
    assert permission_items("nonexistent") == ()
    assert APPROVAL_EXTENSION_PATH.is_file()


def test_approval_notice_matches_connector_context() -> None:
    approval = parse_approval_request(approval_record())
    assert approval is not None
    notice = approval.notice("session-1", "pi-session-1", "turn-1", "ui-1")
    assert notice.notice_id == "pi-ui-ui-1"
    assert notice.interaction_type == "approval"
    assert notice.severity == "warning"
    assert notice.message == "touch example.txt"
    assert notice.response_required is True
    assert notice.blocking == {"scope": "session", "targetId": "session-1"}
    assert [action["actionId"] for action in notice.actions] == ["approve", "reject"]
    assert notice.context == {
        "approvalId": "ui-1",
        "approvalStatus": "pending",
        "kind": "tool",
        "turnId": "turn-1",
        "toolName": "bash",
        "toolInput": {"command": "touch example.txt"},
        "toolContext": {
            "cwd": "/workspace",
            "permission_mode": "ask-writes",
            "session_id": "pi-session-1",
        },
        "approvalSource": {
            "runtime": "pi",
            "toolName": "bash",
            "turnId": "turn-1",
            "sessionId": "pi-session-1",
        },
        "toolCallId": "call-1",
    }
    assert notice.source == notice.context["approvalSource"]
    # Check the complete protocol object remains JSON-serializable.
    json.dumps(asdict(notice))
    for action in ("approve", "reject"):
        resolved = approval.notice(
            "session-1", "pi-session-1", "turn-1", "ui-1", status="resolved", action_id=action
        )
        assert resolved.notice_id == notice.notice_id
        assert resolved.status == "resolved"
        assert resolved.context["approvalStatus"] == "resolved"
        assert resolved.context["responseActionId"] == action
        assert resolved.context["decision"] == ("approved" if action == "approve" else "rejected")
        assert resolved.blocking is None
        assert resolved.actions == ()
        assert resolved.response_required is False


@pytest.mark.parametrize(
    "tool_input, expected",
    [
        ({"path": "test.txt"}, "write: test.txt"),
        ({"file_path": "test.txt"}, "write: test.txt"),
        ({}, "write"),
    ],
)
def test_approval_summary(tool_input: dict[str, Any], expected: str) -> None:
    approval = parse_approval_request(approval_record(toolName="write", toolInput=tool_input))
    assert approval is not None
    assert approval.notice("session-1", None, "turn-1", "ui-1").message == expected


@pytest.mark.parametrize(
    "record",
    [
        {**approval_record(), "title": "Confirm other extension action"},
        {**approval_record(), "method": "input"},
        {**approval_record(), "message": "not json"},
        {**approval_record(), "message": "[]"},
        {**approval_record(), "message": None},
        approval_record(toolName=""),
        approval_record(toolInput=[]),
        approval_record(toolCallId=None),
        approval_record(mode="invalid"),
        approval_record(cwd=None),
    ],
)
def test_unrelated_or_malformed_request_not_classified_as_approval(record: dict[str, Any]) -> None:
    assert parse_approval_request(record) is None


def test_extension_executes_permission_matrix() -> None:
    """Run the actual shipped TypeScript using Node's type stripping, not source checks."""
    node = shutil.which("node") or shutil.which("node.exe")
    if node is None:
        pytest.skip("Node 22+ is required to execute the bundled TypeScript extension")
    version = subprocess.run([node, "--version"], check=True, capture_output=True, text=True)
    if int(version.stdout.strip().lstrip("v").split(".")[0]) < 22:
        pytest.skip("Node 22+ is required to execute the bundled TypeScript extension")
    scenarios: list[dict[str, Any]] = []
    expectations: list[tuple[bool, bool]] = []
    for mode in PERMISSION_MODES:
        # Missing annotations and false/string hints are deliberately not trusted.
        for name, hints, readonly in (
            ("read", {"readOnlyHint": True}, True),
            ("mcp_search", {"readOnlyHint": True}, True),
            ("unknown", None, False),
            ("read", {"readOnlyHint": False}, False),
            ("read", {"readOnlyHint": "true"}, False),
            ("bash", {"readOnlyHint": True}, False),
            ("powershell", {"readOnlyHint": True}, False),
            ("edit", {"readOnlyHint": True}, False),
            ("write", {"readOnlyHint": True}, False),
        ):
            for approve in (True, False):
                prompts = mode == "ask-all" or (mode == "ask-writes" and not readonly)
                blocked = (mode == "read-only" and not readonly) or (prompts and not approve)
                scenarios.append(
                    {
                        "mode": mode,
                        "name": name,
                        "approve": approve,
                        "tools": [{"name": name, "annotations": hints}],
                    }
                )
                expectations.append((prompts, blocked))
    for mode in (None, "invalid"):
        scenarios.append({"mode": mode, "name": "unknown", "approve": False})
        expectations.append((True, True))
    scenarios.append({"mode": "ask-all", "name": "read", "hasUI": False})
    expectations.append((False, True))
    harness = Path(__file__).with_name("approval_harness.mjs")
    # Relative paths work with both native Node and Windows node.exe invoked from WSL.
    result = subprocess.run(
        [node, "--experimental-strip-types", harness.name],
        cwd=harness.parent,
        input=json.dumps(scenarios),
        text=True,
        capture_output=True,
        check=True,
        timeout=30,
    )
    outputs = json.loads(result.stdout)
    assert len(outputs) == len(scenarios)
    for scenario, output, (prompts, blocked) in zip(scenarios, outputs, expectations, strict=True):
        assert bool(output["prompts"]) is prompts, scenario
        assert bool(output["result"] and output["result"].get("block")) is blocked, scenario
        if scenario["mode"] == "full-auto":
            assert output["registryReads"] == 0
        if prompts:
            request = output["prompts"][0]
            assert request["title"] == APPROVAL_TITLE
            parsed = parse_approval_request({**request, "method": "confirm"})
            assert parsed is not None
            assert parsed.tool_name == scenario["name"]
            assert parsed.tool_input == {"path": "file.txt"}
            assert parsed.tool_call_id == "tool-123"
            assert parsed.cwd == "/test/workspace"
