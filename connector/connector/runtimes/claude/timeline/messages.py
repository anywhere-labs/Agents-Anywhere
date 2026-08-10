from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    CommandToolContent,
    FileChangeToolContent,
    GenericSystemContent,
    MarkdownMessageContent,
    MessageTimelineItem,
    McpToolContent,
    ReasoningSystemContent,
    RuntimeTimelineItem,
    SystemTimelineItem,
    TimelineSource,
    ToolCallContent,
    ToolResultContent,
    ToolTimelineItem,
    UnknownSystemContent,
    WebSearchToolContent,
)
from connector.runtimes.claude.domain.session import ClaudeSession


@dataclass(frozen=True, slots=True)
class ClaudeToolBlock:
    block_type: str
    tool_use_id: str
    tool_name: str | None = None
    tool_input: Any = None
    tool_result: Any = None
    is_error: bool = False


@dataclass(frozen=True, slots=True)
class ClaudeSystemBlock:
    block_type: str
    block_index: int
    text: str | None = None
    metadata: Mapping[str, Any] | None = None


class ClaudeMessageProjector:
    def __init__(self) -> None:
        self._order_by_id: dict[str, int] = {}
        self._next_order_seq = 1
        self._tool_calls: dict[str, ClaudeToolBlock] = {}
        self._ignored_task_tool_use_ids: set[str] = set()

    def message_item(
        self,
        session: ClaudeSession,
        turn_id: str,
        role: str,
        text: str,
        event: str,
        status: str = "done",
        client_message_id: str | None = None,
        native_item_id: str | None = None,
        item_id: str | None = None,
        revision: int = 1,
        attachments: tuple[Mapping[str, object], ...] = (),
    ) -> RuntimeTimelineItem:
        stable_key = native_item_id or client_message_id or text
        resolved_item_id = item_id or (
            stable_message_item_id(session, native_item_id)
            if native_item_id
            else _stable_id(
                "message",
                session.session_id,
                session.external_session_id,
                turn_id,
                role,
                stable_key,
            )
        )
        order_seq = self._order_by_id.get(resolved_item_id)
        if order_seq is None:
            order_seq = self._next_order_seq
            self._next_order_seq += 1
            self._order_by_id[resolved_item_id] = order_seq
        return MessageTimelineItem(
            id=resolved_item_id,
            type="message",
            status=status,  # type: ignore[arg-type]
            role=role,  # type: ignore[arg-type]
            turn_id=turn_id,
            content=MarkdownMessageContent(
                text=text,
                metadata=(
                    {"attachments": [dict(attachment) for attachment in attachments]}
                    if attachments
                    else {}
                ),
            ),
            source=TimelineSource(
                runtime="claude",
                external_session_id=session.external_session_id,
                turn_id=turn_id,
                native_item_id=native_item_id,
                event=event,
                client_message_id=client_message_id,
            ),
            revision=revision,
        ).to_platform_item(session_id=session.session_id, order_seq=order_seq)

    def tool_items_for_message(
        self,
        session: ClaudeSession,
        turn_id: str,
        message: Any,
    ) -> tuple[RuntimeTimelineItem, ...]:
        items: list[RuntimeTimelineItem] = []
        for block in message_tool_blocks(message):
            if (
                block.block_type == "tool_use"
                and is_task_event_tool_name(block.tool_name)
            ):
                self._ignored_task_tool_use_ids.add(block.tool_use_id)
                continue
            if (
                block.block_type == "tool_result"
                and block.tool_use_id in self._ignored_task_tool_use_ids
            ):
                continue
            items.append(self.tool_item(session=session, turn_id=turn_id, block=block))
        return tuple(items)

    def system_items_for_message(
        self,
        session: ClaudeSession,
        turn_id: str,
        message: Any,
        event: str,
    ) -> tuple[RuntimeTimelineItem, ...]:
        items: list[RuntimeTimelineItem] = []
        native_message_id = message_id(message)
        for block in message_system_blocks(message):
            item_id = _stable_id(
                "system",
                session.session_id,
                session.external_session_id,
                turn_id,
                native_message_id,
                block.block_index,
                block.block_type,
            )
            order_seq = self._order_by_id.get(item_id)
            if order_seq is None:
                order_seq = self._next_order_seq
                self._next_order_seq += 1
                self._order_by_id[item_id] = order_seq
            content = _system_content(block)
            items.append(
                SystemTimelineItem(
                    id=item_id,
                    type="system",
                    status="done",
                    role="system",
                    turn_id=turn_id,
                    content=content,
                    source=TimelineSource(
                        runtime="claude",
                        external_session_id=session.external_session_id,
                        turn_id=turn_id,
                        native_item_id=native_message_id,
                        native_item_type=block.block_type,
                        event=event,
                        derived_key=block.block_type,
                    ),
                ).to_platform_item(session_id=session.session_id, order_seq=order_seq)
            )
        return tuple(items)

    def tool_item(
        self,
        session: ClaudeSession,
        turn_id: str,
        block: ClaudeToolBlock,
    ) -> RuntimeTimelineItem:
        item_id = _stable_id(
            "tool",
            session.session_id,
            session.external_session_id,
            turn_id,
            block.tool_use_id,
        )
        order_seq = self._order_by_id.get(item_id)
        if order_seq is None:
            order_seq = self._next_order_seq
            self._next_order_seq += 1
            self._order_by_id[item_id] = order_seq

        source = TimelineSource(
            runtime="claude",
            external_session_id=session.external_session_id,
            turn_id=turn_id,
            native_item_id=block.tool_use_id,
            native_item_type=block.block_type,
            event=f"claude.{block.block_type}",
        )
        if block.block_type == "tool_result":
            call = self._tool_calls.get(item_id)
            output = _result_text(block.tool_result)
            return ToolTimelineItem(
                id=item_id,
                type="tool",
                status="failed" if block.is_error else "done",
                role="tool",
                turn_id=turn_id,
                content=ToolResultContent(
                    output=output,
                    metadata={
                        "toolUseId": block.tool_use_id,
                        "toolName": call.tool_name if call else None,
                        "input": call.tool_input if call else None,
                        "result": block.tool_result,
                        "outputText": output,
                        "outputPreview": _preview_text(output),
                        "outputLength": len(output),
                        "isError": block.is_error,
                        **({"error": output} if block.is_error else {}),
                    },
                ),
                source=source,
            ).to_platform_item(session_id=session.session_id, order_seq=order_seq)

        self._tool_calls[item_id] = block
        return ToolTimelineItem(
            id=item_id,
            type="tool",
            status="running",
            role="tool",
            turn_id=turn_id,
            content=_tool_call_content(block),
            source=source,
        ).to_platform_item(session_id=session.session_id, order_seq=order_seq)


def message_role(message: Any) -> str | None:
    raw_role = _extract(message, "role")
    if isinstance(raw_role, str) and raw_role:
        return raw_role
    nested = _extract(message, "message")
    if isinstance(nested, Mapping):
        raw_nested_role = nested.get("role")
        if isinstance(raw_nested_role, str) and raw_nested_role:
            return raw_nested_role
    raw_type = _extract(message, "type")
    return raw_type if isinstance(raw_type, str) and raw_type else None


def message_text(message: Any) -> str | None:
    text = _content_text(_message_content(message))
    if text:
        return text
    result = _extract(message, "result")
    return result if isinstance(result, str) and result else None


def message_tool_blocks(message: Any) -> tuple[ClaudeToolBlock, ...]:
    content = _message_content(message)
    if not isinstance(content, list | tuple):
        return ()
    blocks: list[ClaudeToolBlock] = []
    for block in content:
        block_type = _block_type(block)
        if block_type == "tool_use":
            blocks.append(
                ClaudeToolBlock(
                    block_type="tool_use",
                    tool_use_id=_string(
                        _extract(block, "id", "tool_use_id", "toolUseId")
                    )
                    or _stable_id("tool", repr(block)),
                    tool_name=_string(_extract(block, "name", "tool_name", "toolName"))
                    or "tool",
                    tool_input=_extract(block, "input", "tool_input", "toolInput")
                    or {},
                )
            )
        elif block_type == "tool_result":
            blocks.append(
                ClaudeToolBlock(
                    block_type="tool_result",
                    tool_use_id=_string(_extract(block, "tool_use_id", "toolUseId"))
                    or _stable_id("tool", repr(block)),
                    tool_result=_extract(block, "content", "result", "toolResult"),
                    is_error=_extract(block, "is_error", "isError") is True,
                )
            )
    return tuple(blocks)


def message_system_blocks(message: Any) -> tuple[ClaudeSystemBlock, ...]:
    content = _message_content(message)
    if not isinstance(content, list | tuple):
        return ()
    blocks: list[ClaudeSystemBlock] = []
    for index, block in enumerate(content):
        block_type = _block_type(block)
        if block_type not in {
            "thinking",
            "reasoning",
            "redacted_thinking",
            "system",
            "error",
        }:
            continue
        blocks.append(
            ClaudeSystemBlock(
                block_type=block_type,
                block_index=index,
                text=_system_block_text(block),
                metadata=_system_block_metadata(block),
            )
        )
    return tuple(blocks)


def message_session_id(message: Any) -> str | None:
    value = _extract(message, "session_id", "sessionId")
    return value if isinstance(value, str) and value else None


def message_id(message: Any) -> str | None:
    nested = _extract(message, "message")
    if isinstance(nested, Mapping):
        value = _extract(nested, "id")
        if isinstance(value, str) and value:
            return value
    value = _extract(message, "message_id", "messageId", "id", "uuid")
    return value if isinstance(value, str) and value else None


def is_result_message(message: Any) -> bool:
    if message.__class__.__name__ == "ResultMessage":
        return True
    raw_type = _extract(message, "type")
    subtype = _extract(message, "subtype")
    return raw_type == "result" or (isinstance(subtype, str) and "result" in subtype)


def message_is_error(message: Any) -> bool:
    return _extract(message, "is_error", "isError") is True


def message_error_text(message: Any) -> str | None:
    errors = _extract(message, "errors")
    if isinstance(errors, list) and errors:
        return "; ".join(str(error) for error in errors)
    value = _extract(message, "error", "terminal_reason", "terminalReason")
    return value if isinstance(value, str) and value else None


def _content_text(content: Any) -> str | None:
    if isinstance(content, str):
        return content
    if not isinstance(content, list | tuple):
        return None
    parts: list[str] = []
    for block in content:
        text = _extract(block, "text")
        if isinstance(text, str) and text:
            parts.append(text)
    return "\n".join(parts) if parts else None


def _message_content(message: Any) -> Any:
    nested = _extract(message, "message")
    if isinstance(nested, Mapping):
        return nested.get("content")
    return _extract(message, "content")


def _block_type(block: Any) -> str | None:
    raw_type = _extract(block, "type")
    if isinstance(raw_type, str) and raw_type:
        return raw_type
    name = block.__class__.__name__.lower()
    if "tooluse" in name or "tool_use" in name:
        return "tool_use"
    if "toolresult" in name or "tool_result" in name:
        return "tool_result"
    if "thinking" in name or "reasoning" in name:
        return "thinking"
    if "system" in name:
        return "system"
    return None


def _system_content(block: ClaudeSystemBlock) -> Any:
    metadata = {
        "blockType": block.block_type,
        **dict(block.metadata or {}),
    }
    if block.block_type in {"thinking", "reasoning", "redacted_thinking"}:
        return ReasoningSystemContent(
            text=block.text,
            metadata=metadata,
        )
    if block.block_type == "system":
        return GenericSystemContent(
            text=block.text,
            metadata=metadata,
        )
    return UnknownSystemContent(
        text=block.text,
        metadata=metadata,
    )


def _system_block_text(block: Any) -> str | None:
    value = _extract(block, "thinking", "text", "content", "message")
    if isinstance(value, str) and value:
        return value
    if isinstance(value, list | tuple):
        return _content_text(value)
    return None


def _system_block_metadata(block: Any) -> Mapping[str, Any]:
    if not isinstance(block, Mapping):
        return {}
    return {
        key: value
        for key, value in block.items()
        if key not in {"type", "thinking", "text", "content", "message"}
    }


def _tool_call_content(block: ClaudeToolBlock) -> Any:
    tool_name = block.tool_name or "tool"
    tool_input = block.tool_input if isinstance(block.tool_input, Mapping) else {}
    common = {
        "toolUseId": block.tool_use_id,
        "toolName": tool_name,
        "input": block.tool_input,
    }
    if tool_name == "Bash":
        return CommandToolContent(
            command=_string(tool_input.get("command") or tool_input.get("cmd")) or "",
            input=dict(tool_input),
            metadata=common,
        )
    if tool_name in {"Edit", "Write", "MultiEdit", "NotebookEdit"}:
        return FileChangeToolContent(
            metadata={
                **common,
                "changes": _file_changes(tool_name, tool_input),
            }
        )
    if tool_name in {"WebFetch", "WebSearch"}:
        return WebSearchToolContent(
            title=tool_name,
            input=dict(tool_input),
            metadata={
                **common,
                "query": _string(tool_input.get("query")),
                "url": _string(tool_input.get("url")),
            },
        )
    mcp_parts = _mcp_parts(tool_name)
    if mcp_parts is not None:
        server, tool = mcp_parts
        return McpToolContent(
            title=tool,
            input=dict(tool_input),
            metadata={
                **common,
                "server": server,
                "tool": tool,
            },
        )
    return ToolCallContent(
        title=tool_name,
        input=block.tool_input,
        metadata=common,
    )


def _file_changes(
    tool_name: str,
    tool_input: Mapping[str, Any],
) -> tuple[Mapping[str, Any], ...]:
    path = _string(
        tool_input.get("file_path")
        or tool_input.get("notebook_path")
        or tool_input.get("path")
    )
    action = "add" if tool_name == "Write" else "update"
    diff = _file_diff(tool_name, path or "", tool_input)
    return (
        {
            "path": path,
            "action": action,
            "toolName": tool_name,
            **({"diff": diff} if diff else {}),
        },
    )


def _file_diff(
    tool_name: str,
    path: str,
    tool_input: Mapping[str, Any],
) -> str | None:
    if tool_name == "Write":
        return _string(tool_input.get("content"))
    if tool_name == "Edit":
        return _edit_diff(
            path,
            _string(tool_input.get("old_string")) or "",
            _string(tool_input.get("new_string")) or "",
        )
    if tool_name == "MultiEdit":
        edits = tool_input.get("edits")
        if not isinstance(edits, list):
            return None
        parts: list[str] = []
        for edit in edits:
            if not isinstance(edit, Mapping):
                continue
            parts.append(
                _edit_diff(
                    path,
                    _string(edit.get("old_string")) or "",
                    _string(edit.get("new_string")) or "",
                    include_header=not parts,
                )
            )
        return "\n".join(part for part in parts if part) or None
    if tool_name == "NotebookEdit":
        return _edit_diff(path, "", _result_text(tool_input.get("new_source")))
    return None


def _edit_diff(
    path: str,
    old: str,
    new: str,
    *,
    include_header: bool = True,
) -> str:
    lines: list[str] = []
    if include_header:
        lines.extend([f"--- {path}", f"+++ {path}"])
    lines.append("@@")
    if old:
        lines.extend(f"-{line}" for line in old.splitlines())
    if new:
        lines.extend(f"+{line}" for line in new.splitlines())
    return "\n".join(lines)


def _result_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    text = _content_text(result)
    if text:
        return text
    if result is None:
        return ""
    return json.dumps(result, ensure_ascii=False, sort_keys=True, default=str)


def _preview_text(value: str, limit: int = 4000) -> str:
    return value[-limit:]


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _mcp_parts(tool_name: str | None) -> tuple[str, str] | None:
    if not tool_name or not tool_name.startswith("mcp__"):
        return None
    parts = tool_name.split("__", 2)
    if len(parts) != 3 or not parts[1] or not parts[2]:
        return None
    return parts[1], parts[2]


def is_task_event_tool_name(tool_name: str | None) -> bool:
    return bool(
        tool_name
        and tool_name != "Task"
        and tool_name.startswith("Task")
        and len(tool_name) > 4
        and tool_name[4].isupper()
    )


def _extract(value: Any, *names: str) -> Any:
    if isinstance(value, Mapping):
        for name in names:
            if name in value:
                return value[name]
        return None
    for name in names:
        candidate = getattr(value, name, None)
        if candidate is not None:
            return candidate
    return None


def _stable_id(*parts: Any) -> str:
    return "claude_" + _short(*parts)


def stable_message_item_id(
    session: ClaudeSession,
    native_message_id: str,
) -> str:
    scope = session.external_session_id or session.session_id
    return "claude_msg_" + _short("message", scope, native_message_id)


def _short(*parts: Any) -> str:
    payload = json.dumps(
        parts,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]
