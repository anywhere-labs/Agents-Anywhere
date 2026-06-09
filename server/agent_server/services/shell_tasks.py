from __future__ import annotations

import asyncio
import secrets
from dataclasses import dataclass, field
from typing import Any, Literal


ShellTaskStatus = Literal["starting", "running", "completed", "failed", "cancelled", "abandoned"]


@dataclass
class ShellTask:
    id: str
    session_id: str
    connector_id: str
    command: str
    cwd: str
    timeout_ms: int
    status: ShellTaskStatus = "starting"
    result: dict[str, Any] | None = None
    error: dict[str, str] | None = None
    event: asyncio.Event = field(default_factory=asyncio.Event)

    def view(self) -> dict[str, Any]:
        return {
            "taskId": self.id,
            "sessionId": self.session_id,
            "command": self.command,
            "cwd": self.cwd,
            "timeoutMs": self.timeout_ms,
            "status": self.status,
            "result": self.result,
            "error": self.error,
        }


class ShellTaskManager:
    def __init__(self) -> None:
        self._tasks: dict[str, ShellTask] = {}

    def create(self, *, session_id: str, connector_id: str, command: str, cwd: str, timeout_ms: int) -> ShellTask:
        task_id = f"sht_{secrets.token_urlsafe(12)}"
        task = ShellTask(
            id=task_id,
            session_id=session_id,
            connector_id=connector_id,
            command=command,
            cwd=cwd,
            timeout_ms=timeout_ms,
        )
        self._tasks[task_id] = task
        return task

    def get(self, task_id: str, *, session_id: str) -> ShellTask:
        task = self._tasks.get(task_id)
        if task is None or task.session_id != session_id:
            raise KeyError(task_id)
        return task

    def mark_running(self, task_id: str, *, session_id: str, connector_id: str | None = None) -> ShellTask:
        task = self.get(task_id, session_id=session_id)
        if connector_id is not None and task.connector_id != connector_id:
            raise KeyError(task_id)
        if task.status == "starting":
            task.status = "running"
        return task

    def complete(
        self,
        task_id: str,
        *,
        session_id: str,
        connector_id: str | None = None,
        status: ShellTaskStatus,
        result: dict[str, Any] | None = None,
        error: dict[str, str] | None = None,
    ) -> ShellTask | None:
        task = self._tasks.get(task_id)
        if task is None or task.session_id != session_id:
            return None
        if connector_id is not None and task.connector_id != connector_id:
            return None
        task.status = status
        task.result = result
        task.error = error
        task.event.set()
        return task

    def abandon(self, task_id: str, *, session_id: str) -> ShellTask | None:
        task = self._tasks.get(task_id)
        if task is None or task.session_id != session_id:
            return None
        task.status = "abandoned"
        task.event.set()
        self._tasks.pop(task_id, None)
        return task

    def pop(self, task_id: str, *, session_id: str) -> ShellTask:
        task = self.get(task_id, session_id=session_id)
        self._tasks.pop(task_id, None)
        return task
