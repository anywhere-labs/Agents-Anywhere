from __future__ import annotations

from typing import Any

from connector.claude.normalized import NormalizedClaudeEvent
from connector.claude.timeline_identity import ClaudeTimelineIdentity, content_hash


class ClaudeTimelineReducer:
    def reduce(
        self,
        *,
        session_id: str,
        turn_id: str,
        events: list[NormalizedClaudeEvent],
    ) -> list[dict[str, Any]]:
        items: dict[str, dict[str, Any]] = {}
        order_seq = 1
        for event in events:
            item = self._reduce_event(session_id=session_id, turn_id=turn_id, event=event, order_seq=order_seq)
            if item is None:
                continue
            existing = items.get(item["id"])
            if existing is None:
                items[item["id"]] = item
                order_seq += 1
                continue
            items[item["id"]] = _merge_item(existing, item)
        return sorted(items.values(), key=lambda item: int(item.get("orderSeq") or 0))

    def _reduce_event(
        self,
        *,
        session_id: str,
        turn_id: str,
        event: NormalizedClaudeEvent,
        order_seq: int,
    ) -> dict[str, Any] | None:
        message_id = event.messageId or event.sourceEventId
        if event.toolUseId and event.toolResult is not None:
            item_id = ClaudeTimelineIdentity.tool_result(
                session_id=session_id,
                claude_session_id=event.claudeSessionId,
                tool_use_id=event.toolUseId,
            )
            content = {
                "toolUseId": event.toolUseId,
                "result": event.toolResult,
                "text": event.text,
            }
            return {
                "id": item_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "type": "tool",
                "status": "done",
                "role": "tool",
                "content": content,
                "source": _source(event, turn_id, "tool_result"),
                "orderSeq": order_seq,
                "revision": 1,
                "contentHash": content_hash(content),
                "createdAt": event.timestamp,
                "updatedAt": event.timestamp,
                "completedAt": event.timestamp,
            }

        if event.toolUseId:
            item_id = ClaudeTimelineIdentity.tool_call(
                session_id=session_id,
                claude_session_id=event.claudeSessionId,
                message_id=message_id,
                tool_use_id=event.toolUseId,
            )
            content = {
                "kind": _tool_kind(event.toolName),
                "toolUseId": event.toolUseId,
                "toolName": event.toolName,
                "input": event.toolInput,
            }
            return {
                "id": item_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "type": "tool",
                "status": "running",
                "role": "assistant",
                "content": content,
                "source": _source(event, turn_id, "tool_use"),
                "orderSeq": order_seq,
                "revision": 1,
                "contentHash": content_hash(content),
                "createdAt": event.timestamp,
                "updatedAt": event.timestamp,
            }

        if event.role in {"user", "assistant", "system"} and event.text is not None:
            item_id = ClaudeTimelineIdentity.message(
                session_id=session_id,
                claude_session_id=event.claudeSessionId,
                message_id=message_id,
            )
            content = {"text": event.text}
            if event.attachments:
                content["attachments"] = event.attachments
            source = _source(event, turn_id, "message")
            if event.clientMessageId:
                source["clientMessageId"] = event.clientMessageId
            return {
                "id": item_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "type": "message",
                "status": "done",
                "role": event.role,
                "content": content,
                "source": source,
                "orderSeq": order_seq,
                "revision": 1,
                "contentHash": content_hash(content),
                "createdAt": event.timestamp,
                "updatedAt": event.timestamp,
                "completedAt": event.timestamp,
            }
        return None


def _source(event: NormalizedClaudeEvent, turn_id: str, derived_key: str) -> dict[str, Any]:
    return {
        "runtime": "claude",
        "sessionId": event.claudeSessionId,
        "turnId": turn_id,
        "itemId": event.toolUseId or event.messageId or event.sourceEventId,
        "itemType": event.blockType,
        "event": event.sourceEventId,
        "derivedKey": derived_key,
    }


def _tool_kind(tool_name: str | None) -> str:
    if tool_name in {"Edit", "Write", "NotebookEdit"}:
        return "file_change"
    if tool_name == "Bash":
        return "command"
    if tool_name in {"WebFetch", "WebSearch"}:
        return "web_search"
    return "tool"


def _merge_item(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    if existing.get("type") == "tool" and existing.get("status") != "done" and incoming.get("status") == "done":
        data = dict(existing)
        content = dict(data.get("content") or {})
        incoming_content = incoming.get("content")
        content.update(incoming_content if isinstance(incoming_content, dict) else {})
        data["content"] = content
        data["status"] = "done"
        data["revision"] = int(data.get("revision") or 1) + 1
        data["contentHash"] = content_hash(content)
        data["updatedAt"] = incoming.get("updatedAt")
        data["completedAt"] = incoming.get("completedAt")
        return data
    if _content_score(incoming.get("content")) > _content_score(existing.get("content")):
        return incoming
    return existing


def _content_score(content: Any) -> int:
    return len(str(content or ""))
