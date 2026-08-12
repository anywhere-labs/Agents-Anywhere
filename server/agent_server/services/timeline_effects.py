from __future__ import annotations

import hashlib
import json
from typing import Any

from agent_server.core.models import TimelineItemIn
from agent_server.services.repository_ports import TimelineEffectRepository


def timeline_content_hash(*values: Any) -> str:
    return hashlib.sha256(
        json.dumps(values, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()


async def apply_approval_resolution_to_target_item(
    db: TimelineEffectRepository,
    *,
    session_id: str,
    approval_id: str,
    target_item_id: str | None,
    status: str,
) -> None:
    if target_item_id is None:
        return
    current = {item.id: item for item in await db.timeline.read(session_id)}
    target = current.get(target_item_id)
    if target is None or not isinstance(target.content, dict):
        return
    content = dict(target.content)
    approval_content = dict(content.get("approval")) if isinstance(content.get("approval"), dict) else {}
    approval_content["id"] = approval_id
    approval_content["status"] = status
    content["approval"] = approval_content
    next_status = "done" if status in {"approved", "approved_for_session"} else "cancelled"
    updated = TimelineItemIn.model_validate(
        {
            **target.model_dump(exclude={"updatedSeq"}),
            "status": next_status,
            "content": content,
            "revision": target.revision + 1,
            "contentHash": f"sha256:{timeline_content_hash(next_status, content, status)}",
        }
    )
    await db.upsert_timeline_item(session_id=session_id, item=updated)
