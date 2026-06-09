from __future__ import annotations

from typing import Any

from connector.claude.normalized import NormalizedClaudeEvent


class ClaudeLiveNormalizer:
    def normalize(self, raw_events: list[dict[str, Any]]) -> list[NormalizedClaudeEvent]:
        return [_event for raw in raw_events for _event in _normalize_raw(raw)]


class ClaudeTranscriptNormalizer:
    def normalize(self, raw_entries: list[dict[str, Any]]) -> list[NormalizedClaudeEvent]:
        return [_event for raw in raw_entries for _event in _normalize_raw(raw)]


def _normalize_raw(raw: dict[str, Any]) -> list[NormalizedClaudeEvent]:
    message = raw.get("message") if isinstance(raw.get("message"), dict) else raw
    claude_session_id = _string(raw.get("session_id") or raw.get("sessionId") or raw.get("uuid")) or "unknown"
    source_event_id = _string(raw.get("uuid") or raw.get("id") or message.get("id")) or "unknown"
    message_id = _string(message.get("id") or raw.get("message_id") or raw.get("messageId"))
    role = _string(message.get("role") or raw.get("role"))
    timestamp = _string(raw.get("timestamp") or message.get("timestamp"))
    content = message.get("content")
    if not isinstance(content, list):
        if isinstance(content, str):
            return [
                NormalizedClaudeEvent(
                    claudeSessionId=claude_session_id,
                    sourceEventId=source_event_id,
                    messageId=message_id,
                    role=role if role in {"user", "assistant", "tool", "system"} else None,
                    blockIndex=0,
                    blockType="text",
                    text=content,
                    timestamp=timestamp,
                )
            ]
        return []

    normalized: list[NormalizedClaudeEvent] = []
    for index, block in enumerate(content):
        if not isinstance(block, dict):
            continue
        block_type = _string(block.get("type")) or "unknown"
        if block_type == "text":
            text = _string(block.get("text"))
            if text is not None:
                normalized.append(
                    NormalizedClaudeEvent(
                        claudeSessionId=claude_session_id,
                        sourceEventId=f"{source_event_id}:{index}",
                        messageId=message_id,
                        role=role if role in {"user", "assistant", "tool", "system"} else None,
                        blockIndex=index,
                        blockType=block_type,
                        text=text,
                        timestamp=timestamp,
                    )
                )
        elif block_type == "tool_use":
            normalized.append(
                NormalizedClaudeEvent(
                    claudeSessionId=claude_session_id,
                    sourceEventId=f"{source_event_id}:{index}",
                    messageId=message_id,
                    role="assistant",
                    blockIndex=index,
                    blockType=block_type,
                    toolUseId=_string(block.get("id")),
                    toolName=_string(block.get("name")),
                    toolInput=block.get("input"),
                    timestamp=timestamp,
                )
            )
        elif block_type == "tool_result":
            normalized.append(
                NormalizedClaudeEvent(
                    claudeSessionId=claude_session_id,
                    sourceEventId=f"{source_event_id}:{index}",
                    messageId=message_id,
                    role="tool",
                    blockIndex=index,
                    blockType=block_type,
                    toolUseId=_string(block.get("tool_use_id")),
                    toolResult=block.get("content"),
                    text=_string(block.get("content")),
                    timestamp=timestamp,
                )
            )
    return normalized


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) else None
