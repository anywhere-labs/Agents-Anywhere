"""Permission presets and the bundled extension's tool approval protocol."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimePermissionItem,
    SessionNotice,
)

APPROVAL_TITLE = "PI_AA_TOOL_APPROVAL_V1"
APPROVAL_EXTENSION_PATH = Path(__file__).with_name("extensions") / "approval.ts"
DEFAULT_PERMISSION_MODE = "ask-writes"
PERMISSION_MODES = ("full-auto", "ask-writes", "ask-all", "read-only")


def validate_permission_mode(value: Any) -> str:
    if not isinstance(value, str) or value not in PERMISSION_MODES:
        raise RuntimeInvalidRequestError(
            f"permissionMode must be one of: {', '.join(PERMISSION_MODES)}"
        )
    return value


def permission_items(
    query: str | None = None,
    limit: int = 100,
    *,
    default_mode: str = DEFAULT_PERMISSION_MODE,
) -> tuple[RuntimePermissionItem, ...]:
    descriptions = (
        ("自动执行", "允许所有工具调用，不询问确认。"),
        ("写入前询问", "自动允许标记为只读的工具；命令、编辑、写入及未知工具需要确认。"),
        ("每次询问", "每次工具调用都需要确认，包括只读工具。"),
        ("只读", "仅允许标记为只读的工具，直接阻止其他工具调用。"),
    )
    items = tuple(
        RuntimePermissionItem(
            id=mode,
            selection_id=mode,
            title=title,
            description=description,
            metadata={"default": mode == default_mode},
            # New sessions use the configured mode when a client picks none.
            is_default=mode == default_mode,
        )
        for mode, (title, description) in zip(PERMISSION_MODES, descriptions, strict=True)
    )
    if query:
        needle = query.casefold()
        items = tuple(
            item
            for item in items
            if needle in f"{item.id} {item.title} {item.description}".casefold()
        )
    return items[: max(0, limit)]


@dataclass(frozen=True, slots=True)
class ApprovalRequest:
    tool_name: str
    tool_input: Mapping[str, Any]
    tool_call_id: str
    cwd: str
    mode: str

    def notice(
        self,
        session_id: str,
        external_session_id: str | None,
        turn_id: str,
        request_id: str,
        *,
        status: str = "open",
        action_id: str | None = None,
    ) -> SessionNotice:
        source = {
            "runtime": "pi",
            "toolName": self.tool_name,
            "turnId": turn_id,
            **({"sessionId": external_session_id} if external_session_id else {}),
        }
        context: dict[str, Any] = {
            "approvalId": request_id,
            "approvalStatus": "pending" if status == "open" else status,
            "kind": "tool",
            "turnId": turn_id,
            "toolName": self.tool_name,
            "toolInput": dict(self.tool_input),
            "toolContext": {
                "cwd": self.cwd,
                "permission_mode": self.mode,
                **({"session_id": external_session_id} if external_session_id else {}),
            },
            "approvalSource": source,
            "toolCallId": self.tool_call_id,
        }
        if action_id is not None:
            context["responseActionId"] = action_id
            context["decision"] = "approved" if action_id == "approve" else "rejected"
        command = self.tool_input.get("command")
        path = self.tool_input.get("file_path") or self.tool_input.get("path")
        message = self.tool_name
        if isinstance(command, str) and command:
            message = command
        elif isinstance(path, str) and path:
            message = f"{self.tool_name}: {path}"
        return SessionNotice(
            notice_id=f"pi-ui-{request_id}",
            session_id=session_id,
            runtime="pi",
            type="interaction",
            title="Pi wants to use a tool",
            message=message,
            severity="warning",
            status=status,
            interaction_type="approval",
            blocking={"scope": "session", "targetId": session_id} if status == "open" else None,
            response_required=status == "open",
            actions=(
                {"actionId": "approve", "label": "Approve", "style": "primary"},
                {"actionId": "reject", "label": "Reject", "style": "danger"},
            )
            if status == "open"
            else (),
            source=source,
            context=context,
            metadata={"source": "pi.tool_call"},
        )


def parse_approval_request(record: Mapping[str, Any]) -> ApprovalRequest | None:
    """Recognize only our versioned confirm dialog, leaving other UI unchanged."""

    if record.get("method") != "confirm" or record.get("title") != APPROVAL_TITLE:
        return None
    message = record.get("message")
    if not isinstance(message, str):
        return None
    try:
        data = json.loads(message)
    except ValueError:
        return None
    if not isinstance(data, Mapping):
        return None
    tool_name, tool_input = data.get("toolName"), data.get("toolInput")
    tool_call_id, cwd, mode = data.get("toolCallId"), data.get("cwd"), data.get("mode")
    if (
        not isinstance(tool_name, str)
        or not tool_name
        or not isinstance(tool_input, Mapping)
        or not isinstance(tool_call_id, str)
        or not tool_call_id
        or not isinstance(cwd, str)
        or not isinstance(mode, str)
        or mode not in PERMISSION_MODES
    ):
        return None
    return ApprovalRequest(tool_name, dict(tool_input), tool_call_id, cwd, mode)
