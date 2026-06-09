from __future__ import annotations

import difflib
import hashlib
import json
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

from connector.time import utc_now


# ─── Output shape — matches CodexReducer's ReductionResult ──────────────────


@dataclass(slots=True)
class ReductionResult:
    session_update: dict[str, Any] | None = None
    timeline_items: list[dict[str, Any]] = field(default_factory=list)
    approvals: list[dict[str, Any]] = field(default_factory=list)


# ─── Constants from the research doc (§2.4, §3.5, §5.4) ─────────────────────


# Auto-injected when resuming a session via `claude --resume`. Reducer must
# drop both this user message and the assistant `stop_sequence` line that
# follows it as a pair.
_RESUME_INJECTION_TEXT = "Continue from where you left off."

# Injected after user rejects a tool approval in the TUI dialog.
_REJECT_INJECTION_TEXT = "[Request interrupted by user for tool use]"

# Plain interrupt marker (no "for tool use" suffix).
_INTERRUPT_INJECTION_TEXT = "[Request interrupted by user]"

# Assistant noop marker — Claude emits this with stop_sequence when there's
# nothing to say (resume acks, post-interrupt closures); never user-visible.
_NO_RESPONSE_TEXT = "No response requested."

# Preview-annotation context block injected into user messages by the app.
_PREVIEW_ANNOTATION_RE = re.compile(
    r"<preview-annotation-context>.*?</preview-annotation-context>",
    re.DOTALL,
)

# TUI-internal events. Always present in the JSONL, never user-facing.
_INTERNAL_EVENT_TYPES = {
    "attachment",
    "queue-operation",
    "last-prompt",
    "file-history-snapshot",
    "worktree-state",
}

# Tool name → timeline content.kind (research doc §2.5 + §10.2).
_TOOL_KIND_MAP = {
    "Bash": "command",
    "Edit": "file_change",
    "Write": "file_change",
    "NotebookEdit": "file_change",
    "Read": "file_read",
    "TodoWrite": "plan",       # special-cased into a `system` item
    "Task": "subagent",
    "Agent": "subagent",
    "WebFetch": "web_search",
    "WebSearch": "web_search",
}


# ─── Public reducer ─────────────────────────────────────────────────────────


class ClaudeJsonlReducer:
    """Turn one session's JSONL events into a `ReductionResult`.

    Stateless across files but stateful within a file: tracks turn ids,
    tool_use ↔ tool_result pairing, and stop_reason for turn-boundary
    detection.
    """

    def __init__(self, *, session_id: str, claude_uuid: str) -> None:
        self.session_id = session_id
        self.claude_uuid = claude_uuid
        self._items: list[dict[str, Any]] = []
        self._order = 1
        self._current_turn_id: str | None = None
        self._open_turn_user_uuid: str | None = None
        self._tool_use_by_id: dict[str, dict[str, Any]] = {}
        self._title: str | None = None
        self._cwd: str | None = None
        self._permission_mode: str | None = None
        self._latest_timestamp: str | None = None
        self._last_assistant_stop_reason: str | None = None
        self._last_user_was_resume_injection: bool = False
        self._pending_client_messages: list[dict[str, str | None]] = []

    def register_client_message(self, *, client_message_id: str, text: str | None = None) -> None:
        self._pending_client_messages.append({"clientMessageId": client_message_id, "text": text})

    # ── entry points ────────────────────────────────────────────────────────

    def reduce_full(self, events: Iterable[dict[str, Any]]) -> ReductionResult:
        for event in events:
            self._handle(event)
        # Close any still-open turn at file end. Without an end_turn we
        # leave the last turn dangling rather than fabricating a synthetic
        # turn.end — the session is just `running` until Claude writes more.
        return ReductionResult(
            session_update=self._build_session_update(),
            timeline_items=self._items,
            approvals=[],
        )

    # ── dispatch ────────────────────────────────────────────────────────────

    def _handle(self, event: dict[str, Any]) -> None:
        event_type = event.get("type")
        timestamp = event.get("timestamp")
        if isinstance(timestamp, str):
            self._latest_timestamp = timestamp

        if event_type in _INTERNAL_EVENT_TYPES:
            return
        if event_type == "ai-title" or event_type == "custom-title":
            self._handle_title(event)
            return
        if event_type == "permission-mode" or event_type == "mode":
            self._handle_permission_mode(event)
            return
        if event_type == "summary" or event_type == "pr-link":
            return  # optional, not surfaced on mobile
        if event_type == "system":
            self._handle_system(event)
            return
        if event_type == "user":
            self._handle_user(event)
            return
        if event_type == "assistant":
            self._handle_assistant(event)
            return
        # Unknown types ignored. Logging here would be too noisy across
        # many session files.

    # ── handlers ────────────────────────────────────────────────────────────

    def _handle_title(self, event: dict[str, Any]) -> None:
        title = _string(event.get("aiTitle")) or _string(event.get("customTitle"))
        if title:
            self._title = title

    def _handle_permission_mode(self, event: dict[str, Any]) -> None:
        mode = _string(event.get("permissionMode")) or _string(event.get("mode"))
        if mode:
            self._permission_mode = mode

    def _handle_system(self, event: dict[str, Any]) -> None:
        if event.get("subtype") != "api_error":
            return
        item = self._make_item(
            turn_id=self._current_turn_id,
            uuid=event.get("uuid") or f"sys-{_short_hash(event)}",
            item_type="system",
            status="failed",
            role="system",
            content={
                "kind": "error",
                "code": "claude_api_error",
                "message": _string(event.get("message")) or "Claude API error",
                "details": event,
                "recoverable": True,
            },
            source_event="system",
        )
        self._items.append(item)

    def _handle_user(self, event: dict[str, Any]) -> None:
        message = event.get("message") if isinstance(event.get("message"), dict) else {}
        content = message.get("content")
        cwd = _string(event.get("cwd"))
        if cwd and not self._cwd:
            self._cwd = cwd
        permission_mode = _string(event.get("permissionMode"))
        if permission_mode:
            self._permission_mode = permission_mode

        # Tool result delivery is a `user` event with a list-shaped content.
        if isinstance(content, list):
            consumed_as_tool_result = self._maybe_consume_tool_result(event, content)
            if consumed_as_tool_result:
                return
            # Fall through: list-shaped content with a real text part is a
            # user-typed message, possibly with attachments we ignore.
            text = _extract_text_from_list(content)
        else:
            text = _string(content) or ""

        # Strip injected preview-annotation blocks before any empty-check.
        text = _PREVIEW_ANNOTATION_RE.sub("", text).strip()

        if not text:
            return

        # Filter §3.5 / §5.4: drop auto-injected noise.
        if text == _RESUME_INJECTION_TEXT:
            self._last_user_was_resume_injection = True
            return
        if text == _REJECT_INJECTION_TEXT:
            return
        if text == _INTERRUPT_INJECTION_TEXT or text.startswith(_INTERRUPT_INJECTION_TEXT):
            self.close_open_turn(status="interrupted", stop_reason="interrupted", source_event="user")
            return

        self.close_open_turn(status="done", stop_reason="incomplete")

        uuid = _string(event.get("uuid")) or f"user-{_short_hash(event)}"
        client_message_id = self._consume_client_message_id(text)
        self._current_turn_id = uuid
        self._open_turn_user_uuid = uuid
        self._last_user_was_resume_injection = False
        self._last_assistant_stop_reason = None

        # Open turn.start.
        self._items.append(self._make_item(
            turn_id=uuid,
            uuid=f"{uuid}:turn-start",
            item_type="turn.start",
            status="running",
            role=None,
            content={},
            source_event="user",
            derived_key="turn-start",
        ))
        self._items.append(self._make_item(
            turn_id=uuid,
            uuid=uuid,
            item_type="message",
            status="done",
            role="user",
            content={"text": text, "format": "markdown"},
            source_event="user",
            source_extra={"clientMessageId": client_message_id} if client_message_id else None,
        ))

    def _consume_client_message_id(self, text: str) -> str | None:
        if not self._pending_client_messages:
            return None
        for index, candidate in enumerate(self._pending_client_messages):
            expected = candidate.get("text")
            if expected is None or _client_message_text_matches(text, expected):
                client_message_id = candidate.get("clientMessageId")
                del self._pending_client_messages[index]
                return client_message_id
        return None

    def _maybe_consume_tool_result(
        self, event: dict[str, Any], content_list: list[Any]
    ) -> bool:
        # Top-level `toolUseResult` is a string "User rejected tool use"
        # when the user pressed 3 on the TUI approval dialog. Surfacing
        # this here lets us mark the tool as `cancelled` rather than
        # `failed` (a normal API error). Research doc §5.4.
        tool_use_result_top = event.get("toolUseResult")
        rejection_top_level = (
            isinstance(tool_use_result_top, str)
            and "rejected tool use" in tool_use_result_top.lower()
        )

        consumed_any = False
        for block in content_list:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            consumed_any = True
            tool_use_id = _string(block.get("tool_use_id"))
            if not tool_use_id:
                continue
            tool_use_item = self._tool_use_by_id.get(tool_use_id)
            if tool_use_item is None:
                continue
            output_text = _stringify_tool_result(block.get("content"))
            is_error = bool(block.get("is_error"))
            rejected = rejection_top_level or _is_rejection_text(output_text)
            if rejected:
                tool_use_item["status"] = "cancelled"
            elif is_error:
                tool_use_item["status"] = "failed"
            else:
                tool_use_item["status"] = "done"
            tool_use_item["completedAt"] = _string(event.get("timestamp")) or utc_now()
            inner_content = dict(tool_use_item["content"])
            inner_content["output"] = output_text
            inner_content["outputLength"] = len(output_text)
            if rejected:
                inner_content["approval"] = {"status": "rejected"}
            if is_error and not rejected:
                inner_content["error"] = output_text
            inner_content["isError"] = is_error
            tool_use_item["content"] = inner_content
            tool_use_item["contentHash"] = _hash_content(inner_content)
            tool_use_item["revision"] = tool_use_item.get("revision", 1) + 1
        return consumed_any

    def _handle_assistant(self, event: dict[str, Any]) -> None:
        message = event.get("message") if isinstance(event.get("message"), dict) else {}
        content_list = message.get("content")
        if not isinstance(content_list, list):
            return
        stop_reason = _string(message.get("stop_reason"))

        # §3.5 noise pair: a `Continue from where you left off.` user followed
        # by a `stop_sequence` assistant with no real text is the auto-resume
        # ack. Drop the whole pair.
        if self._last_user_was_resume_injection and stop_reason == "stop_sequence":
            self._last_user_was_resume_injection = False
            return
        self._last_user_was_resume_injection = False

        text_chunks: list[str] = []
        thinking_chunks: list[str] = []
        tool_use_items_this_event: list[dict[str, Any]] = []
        for block in content_list:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "text":
                text = _string(block.get("text"))
                if text:
                    text_chunks.append(text)
            elif kind == "thinking":
                thinking = _string(block.get("thinking"))
                if thinking:
                    thinking_chunks.append(thinking)
            elif kind == "tool_use":
                item = self._build_tool_use_item(event, block)
                tool_use_items_this_event.append(item)

        if thinking_chunks:
            full_thinking = "\n\n".join(thinking_chunks)
            uuid = _string(event.get("uuid")) or _short_hash(event)
            self._items.append(self._make_item(
                turn_id=self._current_turn_id,
                uuid=f"{uuid}:thinking",
                item_type="system",
                status="done",
                role="system",
                content={"kind": "reasoning", "text": full_thinking},
                source_event="assistant",
                derived_key="thinking",
            ))

        text_chunks = [t for t in text_chunks if t != _NO_RESPONSE_TEXT]
        if text_chunks:
            full_text = "\n\n".join(text_chunks)
            uuid = _string(event.get("uuid")) or _short_hash(event)
            self._items.append(self._make_item(
                turn_id=self._current_turn_id,
                uuid=uuid,
                item_type="message",
                status="done",
                role="assistant",
                content={"text": full_text, "format": "markdown"},
                source_event="assistant",
            ))

        for tool_item in tool_use_items_this_event:
            self._items.append(tool_item)
            tool_use_id = tool_item.get("source", {}).get("itemId")
            if isinstance(tool_use_id, str):
                self._tool_use_by_id[tool_use_id] = tool_item

        # Turn-end detection: §2.6 — assistant with stop_reason in
        # {end_turn, stop_sequence} and no pending tool_use. The "no
        # subsequent tool_result" guard is enforced at file end; if any
        # tool_use was emitted in this event, we wait for its result.
        self._last_assistant_stop_reason = stop_reason
        if (
            stop_reason in {"end_turn", "stop_sequence"}
            and not tool_use_items_this_event
            and self._open_turn_user_uuid is not None
        ):
            turn_id = self._open_turn_user_uuid
            self._items.append(self._make_item(
                turn_id=turn_id,
                uuid=f"{turn_id}:turn-end",
                item_type="turn.end",
                status="done",
                role=None,
                content={"stopReason": stop_reason, "result": "completed"},
                source_event="assistant",
                derived_key="turn-end",
            ))
            self._open_turn_user_uuid = None

    def close_open_turn(
        self,
        *,
        status: str = "done",
        stop_reason: str = "completed",
        source_event: str | None = None,
    ) -> dict[str, Any] | None:
        """Force-emit a turn.end for the currently open turn.

        Used when a turn ends without a clean assistant stop (interrupt,
        timeout, PTY death). Returns the synthesized item, or None if no
        turn is open. Mirrors the turn.end shape from `_handle_assistant`.
        """
        if self._open_turn_user_uuid is None:
            return None
        turn_id = self._open_turn_user_uuid
        if source_event is None:
            source_event = "assistant" if stop_reason in {"end_turn", "stop_sequence"} else "synthetic"
        item = self._make_item(
            turn_id=turn_id,
            uuid=f"{turn_id}:turn-end",
            item_type="turn.end",
            status=status,
            role=None,
            content={"stopReason": stop_reason, "result": stop_reason},
            source_event=source_event,
            derived_key="turn-end",
        )
        self._items.append(item)
        self._open_turn_user_uuid = None
        return item

    # ── tool_use → timeline item mapping ────────────────────────────────────

    def _build_tool_use_item(
        self, event: dict[str, Any], block: dict[str, Any]
    ) -> dict[str, Any]:
        tool_use_id = _string(block.get("id")) or _short_hash(block)
        name = _string(block.get("name")) or "unknown"
        inputs = block.get("input") if isinstance(block.get("input"), dict) else {}

        # TodoWrite → a system "plan" item, just like Codex.
        if name == "TodoWrite":
            todos = inputs.get("todos") if isinstance(inputs.get("todos"), list) else []
            return self._make_item(
                turn_id=self._current_turn_id,
                uuid=tool_use_id,
                item_type="system",
                status="running",
                role="system",
                content={"kind": "plan", "todos": todos},
                source_event="tool_use",
            )

        kind = _TOOL_KIND_MAP.get(name)
        if kind is None:
            if name.startswith("mcp__"):
                kind = "mcp"
                inputs_full = dict(inputs)
                _server_tool = name.split("__")
                server = _server_tool[1] if len(_server_tool) > 1 else ""
                tool = _server_tool[2] if len(_server_tool) > 2 else ""
                content: dict[str, Any] = {
                    "kind": "mcp",
                    "server": server,
                    "tool": tool,
                    "arguments": inputs_full,
                }
            else:
                content = {"kind": "generic", "tool": name, "arguments": dict(inputs)}
            return self._make_item(
                turn_id=self._current_turn_id,
                uuid=tool_use_id,
                item_type="tool",
                status="running",
                role="tool",
                content=content,
                source_event="tool_use",
            )

        if kind == "command":
            content = {
                "kind": "command",
                "command": _string(inputs.get("command")) or "",
                "description": _string(inputs.get("description")),
            }
        elif kind == "file_change":
            content = _file_change_content(name, inputs)
        elif kind == "file_read":
            content = {
                "kind": "file_read",
                "path": _string(inputs.get("file_path")) or "",
                "offset": inputs.get("offset"),
                "limit": inputs.get("limit"),
            }
        elif kind == "subagent":
            content = {
                "kind": "subagent",
                "description": _string(inputs.get("description")),
                "prompt": _string(inputs.get("prompt")),
                "subagent_type": _string(inputs.get("subagent_type")),
            }
        elif kind == "web_search":
            content = {
                "kind": "web_search",
                "query": _string(inputs.get("query")) or _string(inputs.get("url")),
                "url": _string(inputs.get("url")),
            }
        else:
            content = {"kind": kind, "arguments": dict(inputs)}

        return self._make_item(
            turn_id=self._current_turn_id,
            uuid=tool_use_id,
            item_type="tool",
            status="running",
            role="tool",
            content=content,
            source_event="tool_use",
        )

    # ── timeline item construction ──────────────────────────────────────────

    def _make_item(
        self,
        *,
        turn_id: str | None,
        uuid: str,
        item_type: str,
        status: str,
        role: str | None,
        content: dict[str, Any],
        source_event: str,
        derived_key: str | None = None,
        source_extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        order_seq = self._order
        self._order += 1
        now = utc_now()
        source: dict[str, Any] = {
            "runtime": "claude",
            "sessionId": self.claude_uuid,
            "turnId": turn_id,
            "itemId": uuid,
            "itemType": source_event,
            "event": source_event,
        }
        if derived_key is not None:
            source["derivedKey"] = derived_key
        if source_extra:
            source.update(source_extra)
        return {
            "id": uuid,
            "sessionId": self.session_id,
            "turnId": turn_id,
            "type": item_type,
            "status": status,
            "role": role,
            "content": content,
            "source": source,
            "orderSeq": order_seq,
            "revision": 1,
            "contentHash": _hash_content(content),
            "createdAt": now,
            "updatedAt": now,
            "completedAt": now if status == "done" else None,
        }

    # ── session-level snapshot ──────────────────────────────────────────────

    def _build_session_update(self) -> dict[str, Any]:
        status = self._derive_session_status()
        update: dict[str, Any] = {
            "sessionId": self.session_id,
            "runtime": "claude",
            "externalSessionId": self.claude_uuid,
            "status": status,
            "lastSyncedAt": utc_now(),
            "sourceObservedAt": self._latest_timestamp or utc_now(),
        }
        if self._title:
            update["title"] = self._title
        if self._cwd:
            update["cwd"] = self._cwd
        if self._latest_timestamp:
            update["lastActivityAt"] = self._latest_timestamp
        if self._permission_mode:
            update["permissionMode"] = self._permission_mode
        return update

    def _derive_session_status(self) -> str:
        if self._open_turn_user_uuid is not None:
            return "running"
        if self._last_assistant_stop_reason in {"end_turn", "stop_sequence"} or not self._items:
            return "idle"
        return "idle"


# ─── helpers ────────────────────────────────────────────────────────────────


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _extract_text_from_list(content_list: list[Any]) -> str:
    pieces: list[str] = []
    for block in content_list:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text = _string(block.get("text"))
            if text:
                pieces.append(text)
    return "\n\n".join(pieces)


def _client_message_text_matches(actual: str, expected: str) -> bool:
    if actual == expected:
        return True
    return actual.startswith(expected) and actual[len(expected) :].startswith("\n\n[")


_REJECTION_MARKERS = (
    "user rejected tool use",
    "the user doesn't want to proceed",
)


def _is_rejection_text(text: str) -> bool:
    lower = text.lower()
    return any(marker in lower for marker in _REJECTION_MARKERS)


def _stringify_tool_result(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces: list[str] = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = _string(block.get("text"))
                if text:
                    pieces.append(text)
        return "\n".join(pieces)
    if content is None:
        return ""
    return json.dumps(content, ensure_ascii=False)


def _file_change_content(tool_name: str, inputs: dict[str, Any]) -> dict[str, Any]:
    path = _string(inputs.get("file_path")) or _string(inputs.get("notebook_path")) or ""
    if tool_name == "Write":
        action = "write"
        content = _string(inputs.get("content"))
        diff = "\n".join("+" + line for line in content.split("\n")) + "\n" if content else None
    elif tool_name == "Edit":
        action = "edit"
        old = _string(inputs.get("old_string")) or ""
        new = _string(inputs.get("new_string")) or ""
        diff = _edit_diff(old, new)
    else:
        action = "edit"
        diff = None
    return {
        "kind": "file_change",
        "changes": [
            {
                "path": path,
                "action": action,
                "diff": diff,
            }
        ],
    }


def _edit_diff(old: str, new: str) -> str | None:
    if not old and not new:
        return None
    old_lines = old.split("\n") if old else []
    new_lines = new.split("\n") if new else []
    diff = list(difflib.unified_diff(old_lines, new_lines, lineterm=""))
    if len(diff) < 3:
        return None
    return "\n".join(diff[2:]) + "\n"


def _hash_content(content: dict[str, Any]) -> str:
    encoded = json.dumps(content, ensure_ascii=False, sort_keys=True, default=str)
    return f"sha256:{hashlib.sha256(encoded.encode('utf-8')).hexdigest()}"


def _short_hash(value: Any) -> str:
    try:
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    except TypeError:
        encoded = str(value)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:12]
