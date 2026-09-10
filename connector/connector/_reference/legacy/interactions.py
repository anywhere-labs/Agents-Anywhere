from __future__ import annotations

import hashlib
import json
from typing import Any

from connector.server.protocol import ProtocolNotice


def approval_notice(approval: dict[str, Any]) -> dict[str, Any]:
    approval_id = _required_string(approval, "id")
    session_id = _required_string(approval, "sessionId")
    source = approval.get("source")
    choices = approval.get("choices")
    if not isinstance(source, dict) or not isinstance(
        source.get("requestId"), (str, int)
    ):
        raise ValueError("approval source requestId is required")
    if not isinstance(choices, list):
        raise ValueError("approval choices are required")
    notice = ProtocolNotice(
        noticeId=_stable_notice_id("approval", approval_id),
        type="interaction",
        sessionId=session_id,
        source={
            "runtime": source.get("runtime"),
            "component": source.get("runtime"),
            "approvalId": approval_id,
            "timelineItemId": approval.get("targetItemId"),
        },
        title=_required_string(approval, "title"),
        message=approval.get("description"),
        severity="warning",
        status="open",
        interactionType="approval",
        blocking={"scope": "session", "targetId": session_id},
        responseRequired=True,
        actions=_approval_actions(choices),
        context={
            "approvalId": approval_id,
            "approvalStatus": "pending",
            "approvalSource": source,
            "turnId": approval.get("turnId"),
            "targetItemId": approval.get("targetItemId"),
            "kind": approval.get("kind") or "unknown",
            "payload": approval.get("payload", {}),
            "choices": choices,
        },
    )
    return notice.model_dump(mode="json", by_alias=True, exclude_none=True)


def _stable_notice_id(kind: str, *values: Any) -> str:
    digest = hashlib.sha256(
        json.dumps(values, ensure_ascii=False, sort_keys=True, default=str).encode(
            "utf-8"
        )
    ).hexdigest()[:24]
    return f"notice_{kind}_{digest}"


def _approval_actions(choices: list[Any]) -> list[dict[str, Any]]:
    actions = {
        "approve": {"actionId": "approve", "label": "Approve", "style": "primary"},
        "approve_for_session": {
            "actionId": "approve_for_session",
            "label": "Approve for session",
            "style": "secondary",
        },
        "reject": {"actionId": "reject", "label": "Reject", "style": "danger"},
        "cancel": {"actionId": "cancel", "label": "Cancel", "style": "secondary"},
    }
    return [actions[choice] for choice in choices if choice in actions]


def _required_string(value: dict[str, Any], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise ValueError(f"approval {key} is required")
    return item
