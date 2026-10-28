from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from connector.logging import logger
from connector.runtime_protocol.models import (
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
)
from connector.runtime_protocol.timeline import timeline_content_hash
from connector.runtimes.antigravity.provider_config import DEFAULT_BRAIN_DIR


def _clean_user_text(raw: str) -> str:
    match = re.search(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", raw, re.DOTALL)
    if match:
        return match.group(1).strip()
    return raw.strip()


class AntigravityTimelineReader:
    def __init__(self, brain_dir: Path | None = None) -> None:
        self.brain_dir = brain_dir or DEFAULT_BRAIN_DIR

    def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        cid = external_session_id or session_id
        transcript_path = (
            self.brain_dir / cid / ".system_generated" / "logs" / "transcript.jsonl"
        )
        if not transcript_path.exists():
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=cid,
                runtime="antigravity",
                items=(),
                complete=True,
            )

        items: list[RuntimeTimelineItem] = []
        order_seq = 1

        try:
            with open(transcript_path, "r", encoding="utf-8") as f:
                for line in f:
                    if not line.strip():
                        continue
                    try:
                        step = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    stype = step.get("type")
                    step_idx = step.get("step_index", order_seq)

                    if stype == "USER_INPUT":
                        raw_content = step.get("content", "")
                        text = _clean_user_text(raw_content)
                        item_id = f"step_{step_idx}_user"
                        content = {"text": text}
                        item_hash = timeline_content_hash(
                            item_type="message",
                            status="done",
                            role="user",
                            content=content,
                        )
                        items.append(
                            RuntimeTimelineItem(
                                id=item_id,
                                session_id=session_id,
                                type="message",
                                status="done",
                                order_seq=order_seq,
                                content_hash=item_hash,
                                role="user",
                                turn_id=str(step_idx),
                                content=content,
                                source={"runtime": "antigravity", "step_index": step_idx},
                            )
                        )
                        order_seq += 1

                    elif stype == "SYSTEM_MESSAGE":
                        raw_content = step.get("content", "")
                        m = re.search(r"\[Message\].*?\bcontent=(.*?)(?:</SYSTEM_MESSAGE>|\Z)", raw_content, re.DOTALL)
                        if m:
                            text = m.group(1).strip()
                            item_id = f"step_{step_idx}_msg"
                            content = {"text": text}
                            item_hash = timeline_content_hash(
                                item_type="message",
                                status="done",
                                role="user",
                                content=content,
                            )
                            items.append(
                                RuntimeTimelineItem(
                                    id=item_id,
                                    session_id=session_id,
                                    type="message",
                                    status="done",
                                    order_seq=order_seq,
                                    content_hash=item_hash,
                                    role="user",
                                    turn_id=str(step_idx),
                                    content=content,
                                    source={"runtime": "antigravity", "step_index": step_idx},
                                )
                            )
                            order_seq += 1

                    elif stype == "PLANNER_RESPONSE":
                        content_text = step.get("content", "")
                        tool_calls = step.get("tool_calls")
                        if content_text:
                            item_id = f"step_{step_idx}_assistant"
                            content = {"text": content_text}
                            item_hash = timeline_content_hash(
                                item_type="message",
                                status="done",
                                role="assistant",
                                content=content,
                            )
                            items.append(
                                RuntimeTimelineItem(
                                    id=item_id,
                                    session_id=session_id,
                                    type="message",
                                    status="done",
                                    order_seq=order_seq,
                                    content_hash=item_hash,
                                    role="assistant",
                                    turn_id=str(step_idx),
                                    content=content,
                                    source={"runtime": "antigravity", "step_index": step_idx},
                                )
                            )
                            order_seq += 1

                        if tool_calls and isinstance(tool_calls, list):
                            for tc in tool_calls:
                                tc_id = tc.get("id", f"tc_{step_idx}")
                                tc_name = tc.get("name", "tool")
                                item_id = f"step_{step_idx}_{tc_id}"
                                content = {
                                    "kind": "tool_call",
                                    "title": tc_name,
                                    "input": tc.get("argumentsJson", "{}"),
                                }
                                item_hash = timeline_content_hash(
                                    item_type="tool",
                                    status="done",
                                    role="assistant",
                                    content=content,
                                )
                                items.append(
                                    RuntimeTimelineItem(
                                        id=item_id,
                                        session_id=session_id,
                                        type="tool",
                                        status="done",
                                        order_seq=order_seq,
                                        content_hash=item_hash,
                                        role="assistant",
                                        turn_id=str(step_idx),
                                        content=content,
                                        source={"runtime": "antigravity", "step_index": step_idx},
                                    )
                                )
                                order_seq += 1

                    elif stype == "GENERIC":
                        content_text = step.get("content", "")
                        if content_text:
                            item_id = f"step_{step_idx}_result"
                            content = {
                                "kind": "tool_result",
                                "title": "tool_output",
                                "output": content_text,
                            }
                            item_hash = timeline_content_hash(
                                item_type="tool",
                                status="done",
                                role="tool",
                                content=content,
                            )
                            items.append(
                                RuntimeTimelineItem(
                                    id=item_id,
                                    session_id=session_id,
                                    type="tool",
                                    status="done",
                                    order_seq=order_seq,
                                    content_hash=item_hash,
                                    role="tool",
                                    turn_id=str(step_idx),
                                    content=content,
                                    source={"runtime": "antigravity", "step_index": step_idx},
                                )
                            )
                            order_seq += 1

            if limit is not None and len(items) > limit:
                items = items[-limit:]

            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=cid,
                runtime="antigravity",
                items=tuple(items),
                complete=True,
            )
        except Exception as e:
            logger.error(f"[Antigravity] Failed to get session snapshot for {session_id}: {e}")
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=cid,
                runtime="antigravity",
                items=(),
                complete=True,
            )
