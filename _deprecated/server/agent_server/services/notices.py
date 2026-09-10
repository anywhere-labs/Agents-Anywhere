from __future__ import annotations

import hashlib
import json
from typing import Any

from agent_server.core.interactions import require_interaction_transition
from agent_server.core.models import (
    Approval,
    Notice,
    NoticeAction,
    NoticeBlocking,
    NoticeIn,
    NoticeSource,
    TimelineItemIn,
)
from agent_server.services.repository_ports import SessionStateRepository
from agent_server.services.session_states import SessionStateService


def stable_notice_id(kind: str, *values: Any) -> str:
    digest = hashlib.sha256(
        json.dumps(values, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:24]
    return f"notice_{kind}_{digest}"


def pending_approvals_from_notices(notices: list[Notice]) -> list[Approval]:
    approvals = [approval_from_interaction_notice(notice) for notice in notices]
    return [approval for approval in approvals if approval is not None]


def approval_from_interaction_notice(notice: Notice) -> Approval | None:
    if (
        notice.type != "interaction"
        or notice.interactionType != "approval"
        or notice.status not in {"open", "response_accepted", "resolving", "failed"}
    ):
        return None
    approval_id = notice.context.get("approvalId") or notice.source.approvalId
    approval_source = notice.context.get("approvalSource")
    choices = notice.context.get("choices")
    if (
        not isinstance(approval_id, str)
        or not isinstance(approval_source, dict)
        or not isinstance(choices, list)
    ):
        return None
    try:
        return Approval(
            id=approval_id,
            sessionId=notice.sessionId,
            turnId=_optional_string(notice.context.get("turnId")),
            status="pending",
            kind=str(notice.context.get("kind") or "unknown"),
            targetItemId=notice.source.timelineItemId
            or _optional_string(notice.context.get("targetItemId")),
            title=notice.title,
            description=notice.message,
            payload=notice.context.get("payload", {}),
            choices=choices,
            source=approval_source,
            updatedSeq=notice.updatedSeq,
            createdAt=notice.createdAt,
            resolvedAt=None,
        )
    except ValueError:
        return None


async def upsert_execution_error_interaction(
    db: SessionStateRepository,
    *,
    session_id: str,
    title: str = "Execution failed",
    message: str | None = None,
    timeline_item: TimelineItemIn | None = None,
    error: dict[str, Any] | None = None,
    reason: str = "execution_failed",
) -> Notice:
    turn_id = timeline_item.turnId if timeline_item is not None else None
    timeline_item_id = timeline_item.id if timeline_item is not None else None
    context = {
        "reason": reason,
        "turnId": turn_id,
        "timelineItemId": timeline_item_id,
        "error": error or _error_from_timeline_item(timeline_item),
    }
    notice = await db.upsert_notice(
        NoticeIn(
            noticeId=stable_notice_id("execution_error", session_id, turn_id, timeline_item_id, context["error"]),
            type="interaction",
            sessionId=session_id,
            source=NoticeSource(runtime="platform", timelineItemId=timeline_item_id),
            title=title,
            message=message or _message_from_error(context["error"]),
            severity="error",
            status="open",
            interactionType="execution_error",
            blocking=NoticeBlocking(scope="session", targetId=session_id),
            responseRequired=True,
            actions=[
                NoticeAction(actionId="continue", label="Continue", style="primary"),
                NoticeAction(actionId="dismiss", label="Dismiss", style="secondary"),
            ],
            context=context,
        )
    )
    await SessionStateService(db).reconcile(session_id)
    return notice


async def cancel_turn_blocking_interactions(
    db: SessionStateRepository,
    *,
    session_id: str,
    turn_id: str | None,
    reason: str,
    reconcile: bool = True,
) -> list[Notice]:
    if turn_id is None:
        return []
    closed: list[Notice] = []
    for notice in await db.list_open_blocking_notices(session_id):
        if notice.context.get("turnId") != turn_id:
            continue
        require_interaction_transition(notice, "cancelled")
        closed.append(
            await db.update_notice_status(
                notice.noticeId,
                "cancelled",
                expected_status=notice.status,
                context_patch={"closedReason": reason},
            )
        )
    if reconcile:
        await SessionStateService(db).reconcile(session_id)
    return closed


async def cancel_session_blocking_interactions(
    db: SessionStateRepository,
    *,
    session_id: str,
    reason: str,
) -> list[Notice]:
    closed: list[Notice] = []
    for notice in await db.list_open_blocking_notices(session_id):
        require_interaction_transition(notice, "cancelled")
        closed.append(
            await db.update_notice_status(
                notice.noticeId,
                "cancelled",
                expected_status=notice.status,
                context_patch={"closedReason": reason},
            )
        )
    await SessionStateService(db).reconcile(session_id)
    return closed


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _error_from_timeline_item(item: TimelineItemIn | None) -> dict[str, Any]:
    if item is None or not isinstance(item.content, dict):
        return {"code": "execution_failed", "message": "The agent execution failed."}
    error = item.content.get("error")
    if isinstance(error, dict):
        return error
    result = item.content.get("result")
    stop_reason = item.content.get("stopReason") or item.content.get("stop_reason")
    return {
        "code": str(result or item.status or "execution_failed"),
        "message": str(stop_reason or "The agent execution failed."),
    }


def _message_from_error(error: dict[str, Any] | None) -> str:
    if not error:
        return "The previous agent execution failed. Review the error before continuing."
    message = error.get("message")
    if isinstance(message, str) and message:
        return message
    return "The previous agent execution failed. Review the error before continuing."
