from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

TERMINAL_STATUSES = frozenset({"completed", "failed", "stopped", "killed"})


def _value(message: Any, name: str) -> Any:
    return (
        message.get(name)
        if isinstance(message, Mapping)
        else getattr(message, name, None)
    )


@dataclass(slots=True)
class ClaudeBackgroundTasks:
    """Track native work that may outlive the reply which started it."""

    active_ids: set[str] = field(default_factory=set)

    def observe(self, message: Any) -> bool:
        """Return whether this was a task lifecycle event."""
        kind = _value(message, "subtype")
        if kind not in {
            "task_started",
            "task_progress",
            "task_updated",
            "task_notification",
        }:
            return False
        task_id = _value(message, "task_id")
        if not isinstance(task_id, str) or not task_id:
            data = _value(message, "data")
            task_id = _value(data, "task_id")
        if not isinstance(task_id, str) or not task_id:
            return True
        if kind in {"task_started", "task_progress"}:
            self.active_ids.add(task_id)
        else:
            patch = _value(message, "patch")
            status = _value(patch, "status") or _value(message, "status")
            if not isinstance(status, str):
                status = _value(_value(message, "data"), "status")
            if status in TERMINAL_STATUSES:
                self.active_ids.discard(task_id)
            elif isinstance(status, str):
                self.active_ids.add(task_id)
        return True
