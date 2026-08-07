from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import SessionNotice
from connector.runtimes.claude import utils


def approval_notice(
    approval_id: str,
    session_id: str,
    external_session_id: str | None,
    active_turn_id: str | None,
    tool_name: str,
    input_data: Mapping[str, Any],
    status: str,
    metadata: Mapping[str, Any] | None = None,
) -> SessionNotice:
    return SessionNotice(
        notice_id=approval_id,
        session_id=session_id,
        runtime="claude",
        type="interaction",
        title=f"Claude requests {tool_name}",
        message=approval_description(tool_name, input_data),
        severity="warning",
        status=status,
        interaction_type="approval",
        blocking={
            "turnId": active_turn_id,
            "reason": "permission_required",
        },
        response_required=status == "open",
        actions=(
            {"id": "approve", "title": "Approve", "style": "primary"},
            {"id": "reject", "title": "Reject", "style": "danger"},
        )
        if status == "open"
        else (),
        source={
            "runtime": "claude",
            "sessionId": external_session_id,
            "turnId": active_turn_id,
            "requestId": approval_id,
            "method": "can_use_tool",
        },
        context={
            "approvalId": approval_id,
            "turnId": active_turn_id,
            "toolName": tool_name,
            "kind": approval_kind(tool_name),
            "payload": {"toolName": tool_name, "input": dict(input_data)},
            "approvalSource": {
                "runtime": "claude",
                "requestId": approval_id,
                "sessionId": external_session_id,
                "turnId": active_turn_id,
                "method": "can_use_tool",
            },
        },
        metadata=dict(metadata or {}),
    )


def approval_kind(tool_name: str) -> str:
    if tool_name == "Bash":
        return "command"
    if tool_name in {"Edit", "Write", "NotebookEdit"}:
        return "file_change"
    return "tool_call"


def approval_description(tool_name: str, input_data: Mapping[str, Any]) -> str:
    if tool_name == "Bash":
        return utils.string(input_data.get("command")) or "Run command"
    if tool_name in {"Edit", "Write", "NotebookEdit"}:
        return utils.string(input_data.get("file_path")) or "Modify file"
    return json.dumps(dict(input_data), ensure_ascii=False, sort_keys=True)


def approval_id(
    session_id: str,
    turn_id: str | None,
    tool_name: str,
    input_data: Mapping[str, Any],
) -> str:
    payload = json.dumps(
        [session_id, turn_id, tool_name, dict(input_data)],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "appr_" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def normalize_approval_action(action_id: str) -> str | None:
    if action_id in {"approve", "approved", "allow"}:
        return "approve"
    if action_id in {"approve_for_session", "approved_for_session"}:
        return "approve_for_session"
    if action_id in {"reject", "rejected", "deny", "denied", "cancel", "cancelled"}:
        return "reject"
    return None


def permission_allow(sdk: Any, input_data: Mapping[str, Any]) -> Any:
    cls = utils.optional_attr(
        sdk, "PermissionResultAllow", "types.PermissionResultAllow"
    )
    if cls is not None:
        return cls(updated_input=dict(input_data))
    return {"behavior": "allow", "updatedInput": dict(input_data)}


def permission_deny(sdk: Any, message: str) -> Any:
    cls = utils.optional_attr(sdk, "PermissionResultDeny", "types.PermissionResultDeny")
    if cls is not None:
        return cls(message=message)
    return {"behavior": "deny", "message": message}
