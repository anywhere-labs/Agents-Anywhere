from __future__ import annotations

import hashlib
import json
from typing import Any

from agent_server.core.models import Approval, TimelineItemIn
from agent_server.infra.repositories.facade import Store


def timeline_content_hash(*values: Any) -> str:
    return hashlib.sha256(
        json.dumps(values, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


async def apply_resolved_approval_to_target_item(db: Store, approval: Approval) -> None:
    if approval.targetItemId is None:
        return
    current = {item.id: item for item in await db.timeline.read(approval.sessionId)}
    target = current.get(approval.targetItemId)
    if target is None or not isinstance(target.content, dict):
        return
    content = dict(target.content)
    approval_content = dict(content.get("approval")) if isinstance(content.get("approval"), dict) else {}
    approval_content["id"] = approval.id
    approval_content["status"] = approval.status
    content["approval"] = approval_content
    next_status = "done" if approval.status in {"approved", "approved_for_session"} else "cancelled"
    updated = TimelineItemIn.model_validate(
        {
            **target.model_dump(exclude={"updatedSeq"}),
            "status": next_status,
            "content": content,
            "revision": target.revision + 1,
            "contentHash": f"sha256:{timeline_content_hash(next_status, content, approval.status)}",
        }
    )
    await db.upsert_timeline_item(session_id=approval.sessionId, item=updated)


async def close_waiting_approval_items_for_finished_turn(
    db: Store, session_id: str, turn_end: TimelineItemIn
) -> None:
    if turn_end.turnId is None:
        return
    result = turn_end.content.get("result") if isinstance(turn_end.content, dict) else None
    if turn_end.status not in {"interrupted", "cancelled", "failed"} and result not in {
        "interrupted",
        "cancelled",
        "failed",
    }:
        return

    for approval in await db.list_pending_approvals(session_id):
        if approval.turnId == turn_end.turnId:
            resolved = await db.resolve_approval(approval.id, "cancelled")
            await apply_resolved_approval_to_target_item(db, resolved)

    for target in await db.timeline.read(session_id):
        if (
            target.turnId != turn_end.turnId
            or target.status != "waiting_approval"
            or not isinstance(target.content, dict)
        ):
            continue
        content = dict(target.content)
        approval_content = dict(content.get("approval")) if isinstance(content.get("approval"), dict) else {}
        approval_content["status"] = "cancelled"
        content["approval"] = approval_content
        updated = TimelineItemIn.model_validate(
            {
                **target.model_dump(exclude={"updatedSeq"}),
                "status": "cancelled",
                "content": content,
                "revision": target.revision + 1,
                "contentHash": f"sha256:{timeline_content_hash('cancelled', content, turn_end.id)}",
            }
        )
        await db.upsert_timeline_item(session_id=session_id, item=updated)
