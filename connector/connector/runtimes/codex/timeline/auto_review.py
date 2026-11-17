"""Codex automatic approval reviews as readable timeline markers.

Codex Desktop records each ``item/autoApprovalReview/started|completed``
notification as an ``automaticApprovalReview`` turn item. The review fields
(``status``, ``riskLevel``, ``userAuthorization``, ``rationale``) are spread on
the item next to ``action`` and ``targetItemId``; the app-server notification
keeps them under ``review``. Both shapes are accepted here.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

AUTOMATIC_APPROVAL_REVIEW = "automaticApprovalReview"

_LABEL_LIMIT = 160
_REVIEW_FIELDS = ("status", "riskLevel", "userAuthorization", "rationale")
_TITLE_BY_STATUS = {
    "inProgress": "自动审查中",
    "approved": "自动审查已批准",
    "denied": "自动审查已拒绝",
    "timedOut": "自动审查超时",
    "aborted": "自动审查已中止",
}
_NATIVE_STATUS_BY_REVIEW_STATUS = {
    "inProgress": "inProgress",
    "approved": "completed",
    "denied": "failed",
    "timedOut": "failed",
    "aborted": "cancelled",
}
_HIGH_RISK_LEVELS = {"high", "critical"}


def auto_review_fields(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    review = raw.get("review")
    return review if isinstance(review, Mapping) else raw


def auto_review_status(raw: Mapping[str, Any]) -> str | None:
    status = auto_review_fields(raw).get("status")
    return status if isinstance(status, str) and status else None


def auto_review_item_status(raw: Mapping[str, Any]) -> str | None:
    """Map the review decision onto the timeline item lifecycle."""

    status = auto_review_status(raw)
    if status is None:
        return None
    return _NATIVE_STATUS_BY_REVIEW_STATUS.get(status, "completed")


def auto_review_content(raw: Mapping[str, Any]) -> dict[str, Any]:
    fields = auto_review_fields(raw)
    status = auto_review_status(raw)
    risk_level = _string(fields, "riskLevel")
    rationale = _string(fields, "rationale")
    title = _TITLE_BY_STATUS.get(status or "", "自动审查")
    if status == "denied" and risk_level in _HIGH_RISK_LEVELS:
        title = "自动审查已拒绝高风险操作"
    action = raw.get("action")
    summary = action_summary(action) if isinstance(action, Mapping) else None
    label = f"{title}：{summary}" if summary else title
    review = {
        key: fields[key]
        for key in _REVIEW_FIELDS
        if fields.get(key) is not None
    }
    target_item_id = _string(raw, "targetItemId", "target_item_id")
    return {
        "kind": "system",
        "label": _truncate(label),
        **({"text": rationale} if rationale else {}),
        "severity": "warning" if status in {"denied", "timedOut"} else "info",
        "review": review,
        **({"action": dict(action)} if isinstance(action, Mapping) else {}),
        **({"targetItemId": target_item_id} if target_item_id else {}),
    }


def action_summary(action: Mapping[str, Any]) -> str | None:
    action_type = _string(action, "type")
    if action_type == "command":
        command = _string(action, "command")
        return f"运行 {command}" if command else "运行命令"
    if action_type == "execve":
        argv = action.get("argv")
        parts = (
            [part for part in argv if isinstance(part, str) and part]
            if isinstance(argv, list)
            else []
        )
        command = " ".join(parts) or _string(action, "program")
        return f"运行 {command}" if command else "运行命令"
    if action_type in {"writeStdin", "write_stdin"}:
        process_id = _string(action, "processId", "process_id")
        return f"向进程 {process_id} 发送输入" if process_id else "向进程发送输入"
    if action_type in {"applyPatch", "apply_patch"}:
        files = action.get("files")
        paths = (
            [path for path in files if isinstance(path, str) and path]
            if isinstance(files, list)
            else []
        )
        if len(paths) == 1:
            return f"编辑 {_basename(paths[0])}"
        if paths:
            return f"编辑 {len(paths)} 个文件"
        return "编辑文件"
    if action_type in {"networkAccess", "network_access"}:
        target = _string(action, "target", "host")
        return f"访问网络 {target}" if target else "访问网络"
    if action_type in {"mcpToolCall", "mcp_tool_call"}:
        tool = _string(action, "toolTitle", "tool_title", "toolName", "tool_name")
        connector = _string(
            action, "connectorName", "connector_name", "server"
        )
        name = f"MCP 工具 {tool}" if tool else "MCP 工具"
        return f"调用 {name}（{connector}）" if connector else f"调用 {name}"
    if action_type in {"requestPermissions", "request_permissions"}:
        reason = _string(action, "reason")
        return f"申请权限：{reason}" if reason else "申请权限"
    return None


def _string(mapping: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _basename(path: str) -> str:
    return path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1] or path


def _truncate(value: str) -> str:
    single_line = " ".join(value.split())
    if len(single_line) <= _LABEL_LIMIT:
        return single_line
    return single_line[: _LABEL_LIMIT - 1] + "…"
