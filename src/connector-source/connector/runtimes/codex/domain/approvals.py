from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import SessionNotice

CODEX_COMMAND_APPROVAL_REQUEST = "item/commandExecution/requestApproval"
CODEX_FILE_CHANGE_APPROVAL_REQUEST = "item/fileChange/requestApproval"
CODEX_PERMISSIONS_APPROVAL_REQUEST = "item/permissions/requestApproval"

CODEX_APPROVAL_REQUEST_METHODS = {
    CODEX_COMMAND_APPROVAL_REQUEST,
    CODEX_FILE_CHANGE_APPROVAL_REQUEST,
    CODEX_PERMISSIONS_APPROVAL_REQUEST,
}


@dataclass(frozen=True, slots=True)
class CodexApprovalResponse:
    payload: Mapping[str, Any]
    decision: str


def is_approval_request(method: object) -> bool:
    return isinstance(method, str) and method in CODEX_APPROVAL_REQUEST_METHODS


def approval_notice_from_request(
    session_id: str,
    thread_id: str,
    method: str,
    params: Mapping[str, Any],
    request_id: object,
    turn_id: str | None = None,
) -> SessionNotice:
    approval_id = _first_string_from_mapping(params, "approvalId", "approval_id")
    if approval_id is None:
        approval_id = _stable_codex_notice_component(
            "approval",
            session_id,
            thread_id,
            method,
            str(request_id),
            _first_string_from_mapping(params, "itemId", "item_id") or "",
        )
    item_id = _first_string_from_mapping(params, "itemId", "item_id")
    command = _first_string_from_mapping(params, "command", "cmd")
    reason = _first_string_from_mapping(params, "reason", "description", "summary")
    title = _approval_notice_title(method)
    message = command or reason
    requested_permissions = _mapping_from_mapping(params, "permissions")
    return SessionNotice(
        notice_id=f"notice_approval_{approval_id}",
        session_id=session_id,
        runtime="codex",
        type="interaction",
        title=title,
        message=message,
        severity="warning",
        interaction_type="approval",
        blocking={"scope": "session", "targetId": session_id},
        response_required=True,
        source={
            "approvalId": approval_id,
            **({"timelineItemId": item_id} if item_id else {}),
        },
        actions=approval_notice_actions(method, params),
        context={
            "approvalId": approval_id,
            "approvalStatus": "pending",
            **({"turnId": turn_id} if turn_id else {}),
            "approvalSource": {
                "requestId": request_id,
                "method": method,
                "threadId": thread_id,
                **({"turnId": turn_id} if turn_id else {}),
                **({"itemId": item_id} if item_id else {}),
            },
            "kind": _approval_kind(method),
            **({"command": command} if command else {}),
            **({"reason": reason} if reason else {}),
            **({"permissions": requested_permissions} if requested_permissions else {}),
            **_optional_context_fields(params, "environmentId", "cwd"),
        },
        metadata={"source": method},
    )


def approval_notice_actions(
    method: str,
    params: Mapping[str, Any],
) -> tuple[Mapping[str, Any], ...]:
    if method == CODEX_PERMISSIONS_APPROVAL_REQUEST:
        return (
            {"actionId": "approve", "label": "Approve for this turn", "style": "primary"},
            {
                "actionId": "approve_for_session",
                "label": "Approve for session",
                "style": "secondary",
            },
            {"actionId": "reject", "label": "Reject", "style": "danger"},
        )
    available_decisions = _string_tuple_from_mapping(params, "availableDecisions")
    if not available_decisions:
        available_decisions = ("accept", "acceptForSession", "decline")
    actions: list[Mapping[str, Any]] = []
    for decision in available_decisions:
        action = _action_from_codex_decision(decision)
        if action is not None:
            actions.append(action)
    if actions:
        return tuple(actions)
    return (
        {"actionId": "approve", "label": "Approve", "style": "primary"},
        {"actionId": "reject", "label": "Reject", "style": "danger"},
    )


def approval_response_from_interaction(
    action_or_status: str,
    context: Mapping[str, Any],
) -> CodexApprovalResponse:
    method = approval_method_from_context(context)
    if method == CODEX_PERMISSIONS_APPROVAL_REQUEST:
        payload = permissions_approval_response(action_or_status, context)
        return CodexApprovalResponse(
            payload=payload,
            decision=str(payload["scope"]),
        )
    decision = command_or_file_approval_decision(action_or_status)
    return CodexApprovalResponse(
        payload={"decision": decision},
        decision=decision,
    )


def approval_method_from_context(context: Mapping[str, Any]) -> str | None:
    approval_source = context.get("approvalSource")
    if isinstance(approval_source, Mapping):
        method = approval_source.get("method")
        if isinstance(method, str):
            return method
    method = context.get("method")
    return method if isinstance(method, str) else None


def permissions_approval_response(
    action_or_status: str,
    context: Mapping[str, Any],
) -> Mapping[str, Any]:
    requested_permissions = _mapping_from_mapping(context, "permissions")
    if action_or_status in {"approved_for_session", "approve_for_session"}:
        return {"scope": "session", "permissions": requested_permissions or {}}
    if action_or_status in {"approved", "approve"}:
        return {"scope": "turn", "permissions": requested_permissions or {}}
    return {"scope": "turn", "permissions": {}}


def command_or_file_approval_decision(status_or_action: str) -> str:
    if status_or_action in {"approved_for_session", "approve_for_session"}:
        return "acceptForSession"
    if status_or_action in {"approved", "approve"}:
        return "accept"
    if status_or_action in {"cancelled", "cancel"}:
        return "cancel"
    return "decline"


def _approval_notice_title(method: str) -> str:
    if method == CODEX_COMMAND_APPROVAL_REQUEST:
        return "Codex wants to run a command"
    if method == CODEX_FILE_CHANGE_APPROVAL_REQUEST:
        return "Codex wants to edit files"
    if method == CODEX_PERMISSIONS_APPROVAL_REQUEST:
        return "Codex requests additional permissions"
    return "Codex requires approval"


def _approval_kind(method: str) -> str:
    if method == CODEX_COMMAND_APPROVAL_REQUEST:
        return "command"
    if method == CODEX_FILE_CHANGE_APPROVAL_REQUEST:
        return "file_change"
    if method == CODEX_PERMISSIONS_APPROVAL_REQUEST:
        return "permissions"
    return "approval"


def _stable_codex_notice_component(*parts: str) -> str:
    digest = hashlib.sha256(":".join(parts).encode()).hexdigest()[:24]
    return f"codex_{digest}"


def _first_string_from_mapping(mapping: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _mapping_from_mapping(
    mapping: Mapping[str, Any],
    key: str,
) -> Mapping[str, Any] | None:
    value = mapping.get(key)
    return value if isinstance(value, Mapping) else None


def _string_tuple_from_mapping(
    mapping: Mapping[str, Any],
    key: str,
) -> tuple[str, ...]:
    value = mapping.get(key)
    if not isinstance(value, list | tuple):
        return ()
    return tuple(item for item in value if isinstance(item, str))


def _optional_context_fields(
    mapping: Mapping[str, Any],
    *keys: str,
) -> Mapping[str, Any]:
    fields: dict[str, Any] = {}
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value:
            fields[key] = value
    return fields


def _action_from_codex_decision(decision: str) -> Mapping[str, Any] | None:
    if decision == "accept":
        return {"actionId": "approve", "label": "Approve", "style": "primary"}
    if decision == "acceptForSession":
        return {
            "actionId": "approve_for_session",
            "label": "Approve for session",
            "style": "secondary",
        }
    if decision == "decline":
        return {"actionId": "reject", "label": "Reject", "style": "danger"}
    if decision == "cancel":
        return {"actionId": "cancel", "label": "Cancel", "style": "secondary"}
    return None
