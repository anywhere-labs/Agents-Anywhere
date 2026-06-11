from __future__ import annotations

import json
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
        ignored_tool_use_ids: set[str] = set()
        order_seq = 1
        for event in events:
            if event.toolUseId and event.toolResult is None and is_task_event_tool_name(event.toolName):
                ignored_tool_use_ids.add(event.toolUseId)
                continue
            if event.toolUseId and event.toolResult is not None and event.toolUseId in ignored_tool_use_ids:
                continue
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
            content = _tool_result_content(event)
            status = "failed" if event.toolResultIsError else "done"
            return {
                "id": item_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "type": "tool",
                "status": status,
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
                tool_use_id=event.toolUseId,
            )
            content = _tool_call_content(event)
            return {
                "id": item_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "type": "tool",
                "status": "running",
                "role": "tool",
                "content": content,
                "source": _source(event, turn_id, "tool_use"),
                "orderSeq": order_seq,
                "revision": 1,
                "contentHash": content_hash(content),
                "createdAt": event.timestamp,
                "updatedAt": event.timestamp,
            }

        if event.role in {"user", "assistant", "system"} and event.text is not None and event.text.strip():
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
    if _mcp_parts(tool_name) is not None:
        return "mcp"
    if tool_name in {"Edit", "Write", "NotebookEdit"}:
        return "file_change"
    if tool_name == "MultiEdit":
        return "file_change"
    if tool_name == "Bash":
        return "command"
    if tool_name in {"WebFetch", "WebSearch"}:
        return "web_search"
    return "tool"


def is_task_event_tool_name(tool_name: str | None) -> bool:
    """Claude Code task bookkeeping tools should not become user-visible tools.

    Keep the real Claude sub-agent tool named exactly "Task"; hide status/event
    tools such as TaskCreate and TaskUpdate.
    """
    return bool(tool_name and tool_name != "Task" and tool_name.startswith("Task") and len(tool_name) > 4 and tool_name[4].isupper())


def _merge_item(existing: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    if existing.get("type") == "tool" and incoming.get("status") in {"done", "failed", "interrupted", "cancelled"}:
        data = dict(existing)
        content = dict(data.get("content") or {})
        incoming_content = incoming.get("content")
        content.update(incoming_content if isinstance(incoming_content, dict) else {})
        data["content"] = content
        data["status"] = incoming.get("status")
        data["role"] = incoming.get("role") or data.get("role")
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


def _tool_call_content(event: NormalizedClaudeEvent) -> dict[str, Any]:
    tool_name = event.toolName or "tool"
    tool_input = event.toolInput if isinstance(event.toolInput, dict) else event.toolInput
    common = _tool_common(event)
    kind = _tool_kind(tool_name)
    if kind == "command":
        input_data = tool_input if isinstance(tool_input, dict) else {}
        command = _string(input_data.get("command") or input_data.get("cmd")) or ""
        content = {
            **common,
            "kind": "command",
            "command": command,
            "description": _string(input_data.get("description")) or command,
            "cwd": _string(input_data.get("cwd")),
        }
        if isinstance(input_data.get("run_in_background"), bool):
            content["runInBackground"] = input_data.get("run_in_background")
        return _strip_empty(content)

    if kind == "file_change":
        return _strip_empty({
            **common,
            "kind": "file_change",
            "changes": _file_changes(tool_name, tool_input),
        })

    if kind == "web_search":
        input_data = tool_input if isinstance(tool_input, dict) else {}
        return _strip_empty({
            **common,
            "kind": "web_search",
            "query": _string(input_data.get("query")),
            "url": _string(input_data.get("url")),
            "action": input_data,
        })

    mcp = _mcp_parts(tool_name)
    if mcp is not None:
        server, tool = mcp
        return _strip_empty({
            **common,
            "kind": "mcp",
            "server": server,
            "tool": tool,
            "arguments": tool_input if isinstance(tool_input, dict) else {},
            "result": None,
            "error": None,
        })

    return _strip_empty({
        **common,
        "kind": "tool",
        "name": tool_name,
        "tool": tool_name,
        "arguments": tool_input if isinstance(tool_input, dict) else tool_input,
    })


def _tool_result_content(event: NormalizedClaudeEvent) -> dict[str, Any]:
    text = _result_text(event.toolResult)
    content: dict[str, Any] = {
        "toolUseId": event.toolUseId,
        "result": event.toolResult,
        "text": text,
        "outputText": text,
        "outputPreview": _preview_text(text),
        "outputLength": len(text),
    }
    if event.toolResultIsError:
        content["isError"] = True
        content["error"] = text
    return content


def _tool_common(event: NormalizedClaudeEvent) -> dict[str, Any]:
    return {
        "toolUseId": event.toolUseId,
        "toolName": event.toolName,
        "input": event.toolInput,
    }


def _file_changes(tool_name: str, tool_input: Any) -> list[dict[str, Any]]:
    input_data = tool_input if isinstance(tool_input, dict) else {}
    if tool_name == "Write":
        path = _string(input_data.get("file_path") or input_data.get("path")) or ""
        text = _string(input_data.get("content")) or ""
        return [_strip_empty({
            "path": path,
            "action": "add",
            "kind": {"type": "add"},
            "diff": text,
        })]
    if tool_name == "Edit":
        path = _string(input_data.get("file_path") or input_data.get("path")) or ""
        return [_strip_empty({
            "path": path,
            "action": "update",
            "kind": {"type": "update"},
            "diff": _edit_diff(
                path,
                _string(input_data.get("old_string")) or "",
                _string(input_data.get("new_string")) or "",
            ),
        })]
    if tool_name == "MultiEdit":
        path = _string(input_data.get("file_path") or input_data.get("path")) or ""
        edits = input_data.get("edits")
        if not isinstance(edits, list):
            edits = []
        diff_parts = []
        for edit in edits:
            if not isinstance(edit, dict):
                continue
            diff_parts.append(
                _edit_diff(
                    path,
                    _string(edit.get("old_string")) or "",
                    _string(edit.get("new_string")) or "",
                    include_header=not diff_parts,
                )
            )
        return [_strip_empty({
            "path": path,
            "action": "update",
            "kind": {"type": "update"},
            "diff": "\n".join(part for part in diff_parts if part),
        })]
    if tool_name == "NotebookEdit":
        path = _string(input_data.get("notebook_path") or input_data.get("file_path") or input_data.get("path")) or ""
        new_source = _string(input_data.get("new_source")) or _json_text(input_data.get("new_source"))
        return [_strip_empty({
            "path": path,
            "action": "update",
            "kind": {"type": "update"},
            "diff": _edit_diff(path, "", new_source),
        })]
    path = _string(input_data.get("file_path") or input_data.get("path")) or ""
    return [_strip_empty({"path": path, "action": "update", "kind": {"type": "update"}})]


def _edit_diff(path: str, old: str, new: str, *, include_header: bool = True) -> str:
    lines: list[str] = []
    if include_header:
        lines.extend([f"--- {path}", f"+++ {path}"])
    lines.append("@@")
    if old:
        lines.extend(f"-{line}" for line in old.splitlines())
    if new:
        lines.extend(f"+{line}" for line in new.splitlines())
    return "\n".join(lines)


def _mcp_parts(tool_name: str | None) -> tuple[str, str] | None:
    if not tool_name or not tool_name.startswith("mcp__"):
        return None
    parts = tool_name.split("__", 2)
    if len(parts) != 3 or not parts[1] or not parts[2]:
        return None
    return parts[1], parts[2]


def _result_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        texts: list[str] = []
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                texts.append(item["text"])
            elif isinstance(item, str):
                texts.append(item)
        if texts:
            return "\n".join(texts)
    if value is None:
        return ""
    return _json_text(value)


def _json_text(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except TypeError:
        return str(value)


def _preview_text(value: str, limit: int = 4000) -> str:
    return value[-limit:]


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _strip_empty(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None}
