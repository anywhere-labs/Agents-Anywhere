from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any

from connector.runtime_protocol import SessionNotice


@dataclass(frozen=True, slots=True)
class ClaudeApprovalDecision:
    allowed: bool
    action_id: str
    message: str | None = None
    updated_input: Mapping[str, Any] | None = None


def approval_notice(
    session_id: str,
    external_session_id: str | None,
    turn_id: str,
    tool_name: str,
    tool_input: Mapping[str, Any],
    context: Any,
    approval_id: str | None = None,
) -> SessionNotice:
    effective_approval_id = approval_id or _stable_approval_id(
        session_id,
        external_session_id,
        turn_id,
        tool_name,
        tool_input,
    )
    return SessionNotice(
        notice_id=f"notice_claude_approval_{effective_approval_id}",
        session_id=session_id,
        runtime="claude",
        type="interaction",
        title="Claude wants to use a tool",
        message=_tool_summary(tool_name, tool_input),
        severity="warning",
        status="open",
        interaction_type="approval",
        blocking={"scope": "session", "targetId": session_id},
        response_required=True,
        actions=(
            {"actionId": "approve", "label": "Approve", "style": "primary"},
            {"actionId": "reject", "label": "Reject", "style": "danger"},
        ),
        source={
            "toolName": tool_name,
            "turnId": turn_id,
            **({"sessionId": external_session_id} if external_session_id else {}),
        },
        context={
            "approvalId": effective_approval_id,
            "approvalStatus": "pending",
            "kind": "tool",
            "turnId": turn_id,
            "toolName": tool_name,
            "toolInput": dict(tool_input),
            "toolContext": _tool_context(context),
            "approvalSource": {
                "runtime": "claude",
                "toolName": tool_name,
                "turnId": turn_id,
                **({"sessionId": external_session_id} if external_session_id else {}),
            },
        },
        metadata={"source": "claude.can_use_tool"},
    )


def decision_from_action(action_id: str) -> ClaudeApprovalDecision:
    if action_id in {"approve", "approved", "accept", "submit"}:
        return ClaudeApprovalDecision(allowed=True, action_id=action_id)
    return ClaudeApprovalDecision(
        allowed=False,
        action_id=action_id,
        message="Denied by user",
    )


def permission_result_from_decision(
    sdk: Any,
    decision: ClaudeApprovalDecision,
    updated_input: Mapping[str, Any] | None = None,
) -> Any:
    if decision.allowed:
        allow_cls = getattr(sdk, "PermissionResultAllow", None)
        if allow_cls is None:
            return {"behavior": "allow", "updatedInput": dict(updated_input or {})}
        try:
            return allow_cls(behavior="allow", updated_input=dict(updated_input or {}))
        except TypeError:
            return allow_cls(updated_input=dict(updated_input or {}))
    deny_cls = getattr(sdk, "PermissionResultDeny", None)
    message = decision.message or "Denied by user"
    if deny_cls is None:
        return {"behavior": "deny", "message": message}
    try:
        return deny_cls(behavior="deny", message=message)
    except TypeError:
        return deny_cls(message=message)


def notice_transition(
    notice: SessionNotice,
    status: str,
    decision: ClaudeApprovalDecision | None = None,
    response_required: bool | None = None,
    clear_blocking: bool = False,
    clear_actions: bool = False,
    metadata: Mapping[str, Any] | None = None,
) -> SessionNotice:
    status_key = (
        "inputStatus"
        if notice.interaction_type == "input_request"
        else "approvalStatus"
    )
    context: dict[str, Any] = {status_key: status}
    if decision is not None:
        context["responseActionId"] = decision.action_id
        context["decision"] = "approved" if decision.allowed else "rejected"
    return replace(
        notice,
        status=status,
        response_required=notice.response_required
        if response_required is None
        else response_required,
        blocking=None if clear_blocking else notice.blocking,
        actions=() if clear_actions else notice.actions,
        context={**dict(notice.context), **context},
        metadata={**dict(notice.metadata), **dict(metadata or {})},
    )


def _stable_approval_id(
    session_id: str,
    external_session_id: str | None,
    turn_id: str,
    tool_name: str,
    tool_input: Mapping[str, Any],
) -> str:
    payload = json.dumps(
        [session_id, external_session_id, turn_id, tool_name, tool_input],
        default=str,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def _tool_summary(tool_name: str, tool_input: Mapping[str, Any]) -> str:
    command = tool_input.get("command")
    if isinstance(command, str) and command:
        return command
    path = tool_input.get("file_path") or tool_input.get("path")
    if isinstance(path, str) and path:
        return f"{tool_name}: {path}"
    return tool_name


def _tool_context(context: Any) -> Mapping[str, Any]:
    if isinstance(context, Mapping):
        return dict(context)
    payload: dict[str, Any] = {}
    for key in ("session_id", "cwd", "permission_mode"):
        value = getattr(context, key, None)
        if isinstance(value, str) and value:
            payload[key] = value
    return payload
