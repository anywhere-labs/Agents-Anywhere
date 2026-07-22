from __future__ import annotations

import hashlib
import json
from typing import Any

from agent_server.core.models import (
    Approval,
    Notice,
    NoticeAction,
    NoticeBlocking,
    NoticeIn,
    NoticeSource,
    TimelineItemIn,
)
from agent_server.infra.repositories.facade import Store


def stable_notice_id(kind: str, *values: Any) -> str:
    digest = hashlib.sha256(
        json.dumps(values, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:24]
    return f"notice_{kind}_{digest}"


async def upsert_approval_interaction(db: Store, approval: Approval) -> Notice:
    return await db.upsert_notice(
        NoticeIn(
            noticeId=stable_notice_id("approval", approval.id),
            type="interaction",
            sessionId=approval.sessionId,
            source=NoticeSource(
                runtime=approval.source.runtime,
                approvalId=approval.id,
                timelineItemId=approval.targetItemId,
            ),
            title=approval.title,
            message=approval.description,
            severity="warning",
            status="open",
            interactionType="approval",
            blocking=NoticeBlocking(scope="session", targetId=approval.sessionId),
            responseRequired=True,
            actions=_approval_actions(approval),
            context={
                "approvalId": approval.id,
                "turnId": approval.turnId,
                "kind": approval.kind,
                "payload": approval.payload,
                "choices": approval.choices,
            },
        )
    )


async def resolve_approval_interaction(
    db: Store,
    approval: Approval,
    *,
    status: str = "resolved",
    reason: str | None = None,
) -> Notice | None:
    notice_id = stable_notice_id("approval", approval.id)
    try:
        return await db.update_notice_status(
            notice_id,
            status,
            context_patch={"approvalStatus": approval.status, **({"closedReason": reason} if reason else {})},
        )
    except KeyError:
        return None


async def upsert_execution_error_interaction(
    db: Store,
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
    return await db.upsert_notice(
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


async def cancel_turn_blocking_interactions(
    db: Store,
    *,
    session_id: str,
    turn_id: str | None,
    reason: str,
) -> list[Notice]:
    if turn_id is None:
        return []
    closed: list[Notice] = []
    for notice in await db.list_open_blocking_notices(session_id):
        if notice.context.get("turnId") != turn_id:
            continue
        closed.append(
            await db.update_notice_status(
                notice.noticeId,
                "cancelled",
                context_patch={"closedReason": reason},
            )
        )
    return closed


async def cancel_session_blocking_interactions(
    db: Store,
    *,
    session_id: str,
    reason: str,
) -> list[Notice]:
    return await db.close_open_blocking_notices(
        session_id,
        status="cancelled",
        reason=reason,
        turn_id=None,
    )


def _approval_actions(approval: Approval) -> list[NoticeAction]:
    mapping = {
        "approve": NoticeAction(actionId="approve", label="Approve", style="primary"),
        "approve_for_session": NoticeAction(
            actionId="approve_for_session",
            label="Approve for session",
            style="secondary",
        ),
        "reject": NoticeAction(actionId="reject", label="Reject", style="danger"),
        "cancel": NoticeAction(actionId="cancel", label="Cancel", style="secondary"),
    }
    return [mapping[choice] for choice in approval.choices if choice in mapping]


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
