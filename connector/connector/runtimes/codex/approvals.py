from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import SessionNotice

CODEX_APPROVAL_REQUEST_METHODS = {
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
}


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
    title = _approval_notice_title(method)
    message = command or _first_string_from_mapping(params, "description", "summary")
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
        actions=(
            {"actionId": "approve", "label": "Approve", "style": "primary"},
            {"actionId": "approve_for_session", "label": "Approve for session", "style": "secondary"},
            {"actionId": "reject", "label": "Reject", "style": "danger"},
        ),
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
        },
        metadata={"source": method},
    )


def approval_decision(status_or_action: str) -> str:
    if status_or_action in {"approved_for_session", "approve_for_session"}:
        return "acceptForSession"
    if status_or_action in {"approved", "approve"}:
        return "accept"
    if status_or_action in {"cancelled", "cancel"}:
        return "cancel"
    return "decline"


def _approval_notice_title(method: str) -> str:
    if method == "item/commandExecution/requestApproval":
        return "Codex wants to run a command"
    if method == "item/fileChange/requestApproval":
        return "Codex wants to edit files"
    if method == "item/permissions/requestApproval":
        return "Codex requests additional permissions"
    return "Codex requires approval"


def _approval_kind(method: str) -> str:
    if method == "item/commandExecution/requestApproval":
        return "command"
    if method == "item/fileChange/requestApproval":
        return "file_change"
    if method == "item/permissions/requestApproval":
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
