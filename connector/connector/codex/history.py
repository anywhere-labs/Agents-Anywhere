from __future__ import annotations

import json
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from loguru import logger


CODEX_HISTORY_ITEM_TYPES = {
    "message",
    "reasoning",
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
}


@dataclass(slots=True)
class CodexHistoryItem:
    turn_id: str | None
    item: dict[str, Any]


def read_timeline_history(
    thread_id: str,
    *,
    rollout_path: str | Path | None = None,
    sessions_root: Path | None = None,
) -> list[CodexHistoryItem]:
    path = _usable_rollout_path(rollout_path)
    if path is None:
        path = find_rollout_path(thread_id, sessions_root=sessions_root)
    if path is None:
        return []

    items: list[CodexHistoryItem] = []
    current_turn_id: str | None = None
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as file:
            for line_no, line in enumerate(file, start=1):
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    logger.trace("codex history line is not json path={} line={}", path, line_no)
                    continue

                record_type = record.get("type")
                payload = record.get("payload")
                if isinstance(payload, dict):
                    turn_id = _turn_id_from_record(record_type, payload)
                    if turn_id:
                        current_turn_id = turn_id

                if record_type != "response_item" or not isinstance(payload, dict):
                    event_item = _event_item(record_type, payload)
                    if event_item is not None:
                        event_item["_historyLine"] = line_no
                        items.append(CodexHistoryItem(turn_id=current_turn_id, item=event_item))
                    continue
                item = _response_item(payload)
                if item is None:
                    continue
                item = dict(item)
                item["_historyLine"] = line_no
                items.append(CodexHistoryItem(turn_id=current_turn_id, item=item))
    except OSError as exc:
        logger.warning("failed to read codex history path={} error={}", path, exc)
        return []
    return items


def read_tool_history(
    thread_id: str,
    *,
    rollout_path: str | Path | None = None,
    sessions_root: Path | None = None,
) -> list[CodexHistoryItem]:
    return [
        entry
        for entry in read_timeline_history(thread_id, rollout_path=rollout_path, sessions_root=sessions_root)
        if entry.item.get("type") in {"function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"}
    ]


def _usable_rollout_path(value: str | Path | None) -> Path | None:
    if value is None:
        return None
    path = Path(value).expanduser()
    if path.is_file():
        return path
    logger.trace("codex rollout path is not readable path={}", path)
    return None


def find_rollout_path(thread_id: str, *, sessions_root: Path | None = None) -> Path | None:
    root = sessions_root or Path.home() / ".codex" / "sessions"
    if not root.exists():
        return None

    matches = sorted(root.rglob(f"rollout-*{thread_id}.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)
    if matches:
        return matches[0]

    # Older or hand-written fixtures may not include the thread id in the filename.
    for path in sorted(root.rglob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True):
        if _jsonl_has_session_id(path, thread_id):
            return path
    return None


def _jsonl_has_session_id(path: Path, thread_id: str) -> bool:
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as file:
            for line in file:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if record.get("type") != "session_meta":
                    continue
                payload = record.get("payload")
                return isinstance(payload, dict) and payload.get("id") == thread_id
    except OSError:
        return False
    return False


def _turn_id_from_record(record_type: Any, payload: dict[str, Any]) -> str | None:
    if record_type == "turn_context" and isinstance(payload.get("turn_id"), str):
        return payload["turn_id"]
    if record_type == "event_msg" and payload.get("type") == "task_started" and isinstance(payload.get("turn_id"), str):
        return payload["turn_id"]
    return None


def _response_item(payload: dict[str, Any]) -> dict[str, Any] | None:
    item_type = payload.get("type")
    if item_type not in CODEX_HISTORY_ITEM_TYPES:
        return None
    if item_type == "message":
        role = payload.get("role")
        if role == "user":
            return {**payload, "type": "userMessage"}
        if role == "assistant":
            return {**payload, "type": "agentMessage"}
        return None
    return dict(payload)


def _event_item(record_type: Any, payload: dict[str, Any]) -> dict[str, Any] | None:
    if record_type != "event_msg":
        return None
    event_type = payload.get("type")
    if event_type == "task_started":
        return {
            "type": "turnStart",
            "id": f"turn-start-{payload.get('turn_id')}",
            "status": "running",
            "_derivedKey": "turn-start",
        }
    if event_type in {"task_complete", "turn_aborted"}:
        result = "interrupted" if event_type == "turn_aborted" else "completed"
        return {
            "type": "turnEnd",
            "id": f"turn-end-{payload.get('turn_id')}",
            "status": result,
            "result": result,
            "error": {"message": payload.get("reason")} if event_type == "turn_aborted" else None,
            "_derivedKey": "turn-end",
        }
    if event_type == "patch_apply_end":
        changes = []
        raw_changes = payload.get("changes")
        if isinstance(raw_changes, dict):
            changes = [
                {"path": str(path), "action": str(change.get("type") or "change") if isinstance(change, dict) else "change"}
                for path, change in raw_changes.items()
            ]
        return {
            "type": "fileChange",
            "id": _string_value(payload.get("call_id")) or f"patch-{_short_event_key(payload)}",
            "changes": changes,
            "status": "completed" if payload.get("success") is True else "failed",
            "_derivedKey": f"patch-{payload.get('call_id') or _short_event_key(payload)}",
        }
    return None


def _short_event_key(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


def _string_value(value: Any) -> str | None:
    return value if isinstance(value, str) else None
