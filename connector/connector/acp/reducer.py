from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from connector.time import utc_now


@dataclass(slots=True)
class AcpReductionResult:
    timeline_items: list[dict[str, Any]] = field(default_factory=list)
    session_update: dict[str, Any] | None = None
    approval: dict[str, Any] | None = None


@dataclass(slots=True)
class AcpTimelineReducer:
    """Map ACP session/update notifications to Agents Anywhere timeline items."""

    runtime: str
    _next_order: int = 1
    _order_by_item: dict[str, int] = field(default_factory=dict)
    _items: dict[str, dict[str, Any]] = field(default_factory=dict)
    _message_text: dict[str, str] = field(default_factory=dict)
    _tool_state: dict[str, dict[str, Any]] = field(default_factory=dict)

    def reset_turn(self) -> None:
        # Keep order counters for session stability; clear only streaming buffers.
        self._message_text.clear()

    def turn_start(
        self,
        *,
        session_id: str,
        turn_id: str,
        external_session_id: str | None,
        content: str | None = None,
        client_message_id: str | None = None,
        attachments: list[dict[str, Any]] | None = None,
    ) -> AcpReductionResult:
        items: list[dict[str, Any]] = []
        items.append(
            self._upsert(
                session_id=session_id,
                turn_id=turn_id,
                item_id=f"{turn_id}:start",
                item_type="turn.start",
                status="running",
                role=None,
                content={},
                external_session_id=external_session_id,
                event="turn.start",
            )
        )
        if content:
            user_content: dict[str, Any] = {"text": content, "format": "markdown"}
            if attachments:
                user_content["attachments"] = attachments
            source_extra = {"clientMessageId": client_message_id} if client_message_id else None
            items.append(
                self._upsert(
                    session_id=session_id,
                    turn_id=turn_id,
                    item_id=f"{turn_id}:user",
                    item_type="message",
                    status="done",
                    role="user",
                    content=user_content,
                    external_session_id=external_session_id,
                    event="user_message",
                    source_extra=source_extra,
                )
            )
        return AcpReductionResult(
            timeline_items=items,
            session_update={
                "sessionId": session_id,
                "runtime": self.runtime,
                "externalSessionId": external_session_id,
                "status": "running",
                "sourceObservedAt": utc_now(),
            },
        )

    def turn_end(
        self,
        *,
        session_id: str,
        turn_id: str,
        external_session_id: str | None,
        stop_reason: str | None,
        interrupted: bool = False,
    ) -> AcpReductionResult:
        status, result = _stop_reason_to_status(stop_reason, interrupted=interrupted)
        item = self._upsert(
            session_id=session_id,
            turn_id=turn_id,
            item_id=f"{turn_id}:end",
            item_type="turn.end",
            status=status,
            role=None,
            content={"result": result, "stopReason": stop_reason or result},
            external_session_id=external_session_id,
            event="turn.end",
            completed_at=utc_now(),
        )
        # Mark in-flight assistant messages done.
        finalized: list[dict[str, Any]] = [item]
        for existing in list(self._items.values()):
            if (
                existing.get("turnId") == turn_id
                and existing.get("type") == "message"
                and existing.get("role") == "assistant"
                and existing.get("status") == "running"
            ):
                finalized.append(
                    self._upsert(
                        session_id=session_id,
                        turn_id=turn_id,
                        item_id=str(existing["source"].get("itemId") or existing["id"]),
                        item_type="message",
                        status="done",
                        role="assistant",
                        content=existing.get("content") or {},
                        external_session_id=external_session_id,
                        event="agent_message_chunk",
                        completed_at=utc_now(),
                    )
                )
        return AcpReductionResult(
            timeline_items=finalized,
            session_update={
                "sessionId": session_id,
                "runtime": self.runtime,
                "externalSessionId": external_session_id,
                "status": "idle" if status != "waiting_approval" else "waiting_approval",
                "sourceObservedAt": utc_now(),
            },
        )

    def reduce_session_update(
        self,
        *,
        session_id: str,
        turn_id: str,
        external_session_id: str | None,
        update: dict[str, Any],
    ) -> AcpReductionResult:
        kind = update.get("sessionUpdate") or update.get("session_update")
        if not isinstance(kind, str):
            return AcpReductionResult()

        if kind in {"agent_message_chunk", "user_message_chunk", "agent_thought_chunk"}:
            return self._reduce_message_chunk(
                session_id=session_id,
                turn_id=turn_id,
                external_session_id=external_session_id,
                kind=kind,
                update=update,
            )
        if kind in {"tool_call", "tool_call_update"}:
            return self._reduce_tool_call(
                session_id=session_id,
                turn_id=turn_id,
                external_session_id=external_session_id,
                update=update,
                is_update=kind == "tool_call_update",
            )
        if kind == "plan":
            entries = update.get("entries") if isinstance(update.get("entries"), list) else []
            text = "\n".join(
                str(entry.get("content") or "")
                for entry in entries
                if isinstance(entry, dict) and entry.get("content")
            )
            if not text:
                return AcpReductionResult()
            item = self._upsert(
                session_id=session_id,
                turn_id=turn_id,
                item_id=f"{turn_id}:plan",
                item_type="system",
                status="done",
                role="system",
                content={"text": text, "format": "markdown", "kind": "plan"},
                external_session_id=external_session_id,
                event="plan",
            )
            return AcpReductionResult(timeline_items=[item])
        if kind == "session_info_update":
            session_update: dict[str, Any] = {
                "sessionId": session_id,
                "runtime": self.runtime,
                "externalSessionId": external_session_id,
                "sourceObservedAt": utc_now(),
            }
            if "title" in update:
                session_update["title"] = update.get("title")
            return AcpReductionResult(session_update=session_update)
        return AcpReductionResult()

    def reduce_permission_request(
        self,
        *,
        session_id: str,
        turn_id: str,
        external_session_id: str | None,
        request_id: str | int,
        params: dict[str, Any],
    ) -> AcpReductionResult:
        tool_call = params.get("toolCall") if isinstance(params.get("toolCall"), dict) else {}
        tool_call_id = str(tool_call.get("toolCallId") or tool_call.get("tool_call_id") or request_id)
        title = str(
            tool_call.get("title")
            or params.get("title")
            or f"{self.runtime} requests permission"
        )
        options = params.get("options") if isinstance(params.get("options"), list) else []
        choices = _permission_choices(options)
        kind = _tool_kind_to_approval_kind(tool_call.get("kind"))
        tool_item = self._upsert(
            session_id=session_id,
            turn_id=turn_id,
            item_id=tool_call_id,
            item_type="tool",
            status="waiting_approval",
            role="tool",
            content={
                "toolCallId": tool_call_id,
                "title": title,
                "kind": _map_tool_kind(tool_call.get("kind")),
                "rawInput": tool_call.get("rawInput") or tool_call.get("raw_input"),
            },
            external_session_id=external_session_id,
            event="request_permission",
        )
        approval = {
            "id": f"appr_{self.runtime}_{_short_hash([session_id, str(request_id)])}",
            "sessionId": session_id,
            "turnId": turn_id,
            "status": "pending",
            "kind": kind,
            "targetItemId": tool_item["id"],
            "title": title,
            "description": _permission_description(options),
            "payload": {
                "toolCall": tool_call,
                "options": options,
                "requestId": request_id,
            },
            "choices": choices,
            "source": {
                "runtime": self.runtime,
                "requestId": request_id,
                "sessionId": external_session_id,
                "turnId": turn_id,
                "itemId": tool_call_id,
                "method": "session/request_permission",
            },
            "createdAt": utc_now(),
        }
        return AcpReductionResult(
            timeline_items=[tool_item],
            approval=approval,
            session_update={
                "sessionId": session_id,
                "runtime": self.runtime,
                "externalSessionId": external_session_id,
                "status": "waiting_approval",
                "sourceObservedAt": utc_now(),
            },
        )

    def _reduce_message_chunk(
        self,
        *,
        session_id: str,
        turn_id: str,
        external_session_id: str | None,
        kind: str,
        update: dict[str, Any],
    ) -> AcpReductionResult:
        content_block = update.get("content") if isinstance(update.get("content"), dict) else {}
        delta = ""
        if isinstance(content_block.get("text"), str):
            delta = content_block["text"]
        elif isinstance(update.get("text"), str):
            delta = update["text"]
        if not delta and kind != "agent_thought_chunk":
            return AcpReductionResult()

        message_id = (
            str(update.get("messageId") or update.get("message_id") or "")
            or f"{turn_id}:{kind}"
        )
        previous = self._message_text.get(message_id, "")
        text = previous + delta
        self._message_text[message_id] = text

        if kind == "user_message_chunk":
            role = "user"
            item_type = "message"
            status = "done"
        elif kind == "agent_thought_chunk":
            role = "assistant"
            item_type = "message"
            status = "running"
            content = {"text": text, "format": "markdown", "kind": "thinking"}
            item = self._upsert(
                session_id=session_id,
                turn_id=turn_id,
                item_id=message_id,
                item_type=item_type,
                status=status,
                role=role,
                content=content,
                external_session_id=external_session_id,
                event=kind,
            )
            return AcpReductionResult(timeline_items=[item])
        else:
            role = "assistant"
            item_type = "message"
            status = "running"

        item = self._upsert(
            session_id=session_id,
            turn_id=turn_id,
            item_id=message_id,
            item_type=item_type,
            status=status,
            role=role,
            content={"text": text, "format": "markdown"},
            external_session_id=external_session_id,
            event=kind,
        )
        return AcpReductionResult(timeline_items=[item])

    def _reduce_tool_call(
        self,
        *,
        session_id: str,
        turn_id: str,
        external_session_id: str | None,
        update: dict[str, Any],
        is_update: bool,
    ) -> AcpReductionResult:
        tool_call_id = str(update.get("toolCallId") or update.get("tool_call_id") or "tool")
        prev = self._tool_state.get(tool_call_id, {})
        status = _tool_status(update.get("status") or prev.get("status") or "pending")
        title = update.get("title") if update.get("title") is not None else prev.get("title")
        kind = update.get("kind") if update.get("kind") is not None else prev.get("kind")
        raw_input = update.get("rawInput") if "rawInput" in update else update.get("raw_input", prev.get("rawInput"))
        raw_output = update.get("rawOutput") if "rawOutput" in update else update.get("raw_output", prev.get("rawOutput"))
        content_blocks = update.get("content") if isinstance(update.get("content"), list) else prev.get("contentBlocks")
        preview = _tool_content_preview(content_blocks)
        state = {
            "title": title,
            "kind": kind,
            "status": status,
            "rawInput": raw_input,
            "rawOutput": raw_output,
            "contentBlocks": content_blocks,
        }
        self._tool_state[tool_call_id] = state
        content: dict[str, Any] = {
            "toolCallId": tool_call_id,
            "toolName": title or kind or "tool",
            "title": title,
            "kind": _map_tool_kind(kind),
            "status": status,
        }
        if isinstance(raw_input, dict):
            content["rawInput"] = raw_input
            if isinstance(raw_input.get("command"), str):
                content["command"] = raw_input["command"]
                content["kind"] = "command"
        if raw_output is not None:
            content["rawOutput"] = raw_output
            content["result"] = _stringify_output(raw_output)
            content["outputPreview"] = content["result"][:2000]
        if preview:
            content["outputPreview"] = preview[:2000]
            content.setdefault("result", preview)
        item = self._upsert(
            session_id=session_id,
            turn_id=turn_id,
            item_id=tool_call_id,
            item_type="tool",
            status=status,
            role="tool",
            content=content,
            external_session_id=external_session_id,
            event="tool_call_update" if is_update else "tool_call",
            completed_at=utc_now() if status in {"done", "failed", "cancelled"} else None,
        )
        return AcpReductionResult(timeline_items=[item])

    def _upsert(
        self,
        *,
        session_id: str,
        turn_id: str | None,
        item_id: str,
        item_type: str,
        status: str,
        role: str | None,
        content: dict[str, Any],
        external_session_id: str | None,
        event: str | None,
        source_extra: dict[str, Any] | None = None,
        completed_at: str | None = None,
    ) -> dict[str, Any]:
        timeline_id = _timeline_id(session_id, self.runtime, external_session_id, turn_id, item_id)
        order_seq = self._order_by_item.setdefault(timeline_id, self._allocate_order_seq())
        existing = self._items.get(timeline_id)
        revision = int(existing.get("revision", 0)) + 1 if existing else 1
        now = utc_now()
        source: dict[str, Any] = {
            "runtime": self.runtime,
            "sessionId": external_session_id,
            "turnId": turn_id,
            "itemId": item_id,
            "itemType": item_type,
            "event": event,
        }
        if source_extra:
            source.update(source_extra)
        source = {key: value for key, value in source.items() if value is not None}
        content_hash = _content_hash(item_type, status, role, content, source)
        if existing and existing.get("contentHash") == content_hash:
            return existing
        snapshot: dict[str, Any] = {
            "id": timeline_id,
            "sessionId": session_id,
            "turnId": turn_id,
            "type": item_type,
            "status": status,
            "role": role,
            "content": content,
            "source": source,
            "orderSeq": order_seq,
            "revision": revision,
            "contentHash": content_hash,
            "createdAt": existing.get("createdAt") if existing else now,
            "updatedAt": now,
            "completedAt": completed_at,
        }
        if role is None:
            snapshot.pop("role", None)
        if turn_id is None:
            snapshot.pop("turnId", None)
        if completed_at is None:
            snapshot.pop("completedAt", None)
        self._items[timeline_id] = snapshot
        return snapshot

    def _allocate_order_seq(self) -> int:
        value = self._next_order
        self._next_order += 1
        return value


def map_approval_status_to_option(
    status: str,
    options: list[dict[str, Any]] | None,
) -> str | None:
    """Map AA approval status to an ACP permission optionId."""
    options = options or []
    if status == "approved":
        preferred_ids = ("allow-once", "allow_once", "allow-always", "allow_always")
        preferred_kinds = {"allow_once", "allow_always"}
    elif status == "approved_for_session":
        preferred_ids = ("allow-always", "allow_always", "allow-once", "allow_once")
        preferred_kinds = {"allow_always", "allow_once"}
    elif status == "rejected":
        preferred_ids = ("reject-once", "reject_once", "reject-always", "reject_always")
        preferred_kinds = {"reject_once", "reject_always"}
    else:
        return None

    by_id = {
        str(opt.get("optionId") or opt.get("option_id") or ""): opt
        for opt in options
        if isinstance(opt, dict)
    }
    for candidate in preferred_ids:
        if candidate in by_id and candidate:
            return candidate
    for opt in options:
        if not isinstance(opt, dict):
            continue
        kind = str(opt.get("kind") or "").replace("-", "_")
        option_id = str(opt.get("optionId") or opt.get("option_id") or "")
        if kind in preferred_kinds and option_id:
            return option_id
    return None


def _stop_reason_to_status(stop_reason: str | None, *, interrupted: bool) -> tuple[str, str]:
    if interrupted or stop_reason == "cancelled":
        return "interrupted", "interrupted"
    if stop_reason in {"refusal", "max_tokens", "max_turn_requests"}:
        return "failed", stop_reason or "failed"
    if stop_reason in {"error", "failed"}:
        return "failed", "failed"
    return "done", "completed"


def _tool_status(raw: Any) -> str:
    text = str(raw or "pending")
    mapping = {
        "pending": "pending",
        "in_progress": "running",
        "in-progress": "running",
        "completed": "done",
        "failed": "failed",
        "cancelled": "cancelled",
        "canceled": "cancelled",
    }
    return mapping.get(text, "running" if text else "pending")


def _map_tool_kind(kind: Any) -> str:
    text = str(kind or "other")
    if text in {"read", "search", "fetch", "think"}:
        return "read"
    if text in {"edit", "delete", "move"}:
        return "edit"
    if text in {"execute"}:
        return "command"
    return "other"


def _tool_kind_to_approval_kind(kind: Any) -> str:
    text = str(kind or "")
    if text == "execute":
        return "command"
    if text in {"edit", "delete", "move"}:
        return "file_change"
    return "tool_call"


def _permission_choices(options: list[Any]) -> list[str]:
    choices: list[str] = []
    for opt in options:
        if not isinstance(opt, dict):
            continue
        kind = str(opt.get("kind") or "").replace("-", "_")
        if kind in {"allow_once"} and "approve" not in choices:
            choices.append("approve")
        elif kind in {"allow_always"} and "approve_for_session" not in choices:
            choices.append("approve_for_session")
        elif kind in {"reject_once", "reject_always"} and "reject" not in choices:
            choices.append("reject")
    if not choices:
        choices = ["approve", "reject"]
    if "cancel" not in choices:
        choices.append("cancel")
    return choices


def _permission_description(options: list[Any]) -> str | None:
    labels = []
    for opt in options:
        if isinstance(opt, dict) and opt.get("name"):
            labels.append(str(opt["name"]))
    return ", ".join(labels) if labels else None


def _tool_content_preview(blocks: Any) -> str:
    if not isinstance(blocks, list):
        return ""
    parts: list[str] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "content" and isinstance(block.get("content"), dict):
            text = block["content"].get("text")
            if isinstance(text, str):
                parts.append(text)
        elif isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(parts)


def _stringify_output(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except TypeError:
        return str(value)


def _timeline_id(
    session_id: str,
    runtime: str,
    external_session_id: str | None,
    turn_id: str | None,
    item_id: str | None,
) -> str:
    identity = [session_id, runtime, external_session_id, turn_id, item_id]
    return f"tl_{_short_hash(identity)}"


def _content_hash(*values: Any) -> str:
    return f"sha256:{_short_hash(values, length=64)}"


def _short_hash(value: Any, *, length: int = 20) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:length]
