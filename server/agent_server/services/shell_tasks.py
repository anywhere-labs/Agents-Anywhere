from __future__ import annotations

import asyncio
import json
import math
import secrets
import time
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Literal

from agent_server.infra.redis_coordinator import RedisCoordinator

ShellTaskStatus = Literal[
    "starting", "running", "completed", "failed", "cancelled", "abandoned"
]
_FINAL_STATUSES = {"completed", "failed", "cancelled", "abandoned"}


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
    event: asyncio.Event = field(
        default_factory=asyncio.Event, repr=False, compare=False
    )

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

    def _payload(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "connector_id": self.connector_id,
            "command": self.command,
            "cwd": self.cwd,
            "timeout_ms": self.timeout_ms,
            "status": self.status,
            "result": self.result,
            "error": self.error,
        }

    @classmethod
    def _from_payload(cls, payload: dict[str, Any]) -> ShellTask:
        task = cls(
            id=str(payload["id"]),
            session_id=str(payload["session_id"]),
            connector_id=str(payload["connector_id"]),
            command=str(payload["command"]),
            cwd=str(payload["cwd"]),
            timeout_ms=int(payload["timeout_ms"]),
            status=payload["status"],
            result=payload.get("result"),
            error=payload.get("error"),
        )
        if task.status in _FINAL_STATUSES:
            task.event.set()
        return task


class ShellTaskManager:
    """Short-lived shell task state shared between server instances."""

    def __init__(self, coordinator: RedisCoordinator | None = None) -> None:
        self._coordinator = coordinator or RedisCoordinator()
        self._tasks: dict[str, ShellTask] = {}
        self._lock = asyncio.Lock()

    async def create(
        self,
        *,
        session_id: str,
        connector_id: str,
        command: str,
        cwd: str,
        timeout_ms: int,
    ) -> ShellTask:
        task_id = f"sht_{secrets.token_urlsafe(12)}"
        task = ShellTask(
            id=task_id,
            session_id=session_id,
            connector_id=connector_id,
            command=command,
            cwd=cwd,
            timeout_ms=timeout_ms,
        )
        if self._coordinator.distributed:
            await self._store_distributed(task)
        else:
            async with self._lock:
                self._tasks[task_id] = task
        return task

    async def get(self, task_id: str, *, session_id: str) -> ShellTask:
        task = await self._get_unscoped(task_id)
        if task is None or task.session_id != session_id:
            raise KeyError(task_id)
        return task

    async def mark_running(
        self,
        task_id: str,
        *,
        session_id: str,
        connector_id: str | None = None,
    ) -> ShellTask:
        if self._coordinator.distributed:
            async with self._coordinator.lock(
                f"shell-task:{task_id}", timeout_seconds=5
            ):
                task = await self.get(task_id, session_id=session_id)
                self._require_connector(task, connector_id)
                if task.status == "starting":
                    task.status = "running"
                    await self._store_distributed(task)
                return task
        async with self._lock:
            task = self._get_local(task_id, session_id)
            self._require_connector(task, connector_id)
            if task.status == "starting":
                task.status = "running"
            return task

    async def complete(
        self,
        task_id: str,
        *,
        session_id: str,
        connector_id: str | None = None,
        status: ShellTaskStatus,
        result: dict[str, Any] | None = None,
        error: dict[str, str] | None = None,
    ) -> ShellTask | None:
        if self._coordinator.distributed:
            async with self._coordinator.lock(
                f"shell-task:{task_id}", timeout_seconds=5
            ):
                task = await self._get_unscoped(task_id)
                if not self._matches(task, session_id, connector_id):
                    return None
                assert task is not None
                task.status = status
                task.result = result
                task.error = error
                task.event.set()
                await self._store_distributed(task)
            await self._coordinator.client.publish(
                self._channel(task_id),
                json.dumps(
                    {"taskId": task_id, "status": status}, separators=(",", ":")
                ),
            )
            return task
        async with self._lock:
            task = self._tasks.get(task_id)
            if not self._matches(task, session_id, connector_id):
                return None
            assert task is not None
            task.status = status
            task.result = result
            task.error = error
            task.event.set()
            return task

    async def wait(
        self,
        task_id: str,
        *,
        session_id: str,
        timeout_seconds: float,
    ) -> ShellTask:
        if not self._coordinator.distributed:
            task = await self.get(task_id, session_id=session_id)
            if task.status not in _FINAL_STATUSES:
                await asyncio.wait_for(task.event.wait(), timeout=timeout_seconds)
            return task

        pubsub = self._coordinator.client.pubsub()
        await pubsub.subscribe(self._channel(task_id))
        deadline = time.monotonic() + timeout_seconds
        try:
            # Subscribing before reading prevents a completion between GET and SUBSCRIBE
            # from leaving this waiter asleep until its timeout.
            while True:
                task = await self.get(task_id, session_id=session_id)
                if task.status in _FINAL_STATUSES:
                    return task
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True,
                    timeout=remaining,
                )
                if message is None and time.monotonic() >= deadline:
                    raise TimeoutError
                if message is None:
                    await asyncio.sleep(min(0.01, max(0, deadline - time.monotonic())))
        finally:
            with suppress(Exception):
                await pubsub.unsubscribe(self._channel(task_id))
            await pubsub.aclose()

    async def abandon(self, task_id: str, *, session_id: str) -> ShellTask | None:
        if self._coordinator.distributed:
            async with self._coordinator.lock(
                f"shell-task:{task_id}", timeout_seconds=5
            ):
                task = await self._get_unscoped(task_id)
                if task is None or task.session_id != session_id:
                    return None
                task.status = "abandoned"
                task.event.set()
                await self._coordinator.client.delete(self._key(task_id))
            await self._coordinator.client.publish(
                self._channel(task_id),
                json.dumps(
                    {"taskId": task_id, "status": "abandoned"}, separators=(",", ":")
                ),
            )
            return task
        async with self._lock:
            task = self._tasks.get(task_id)
            if task is None or task.session_id != session_id:
                return None
            task.status = "abandoned"
            task.event.set()
            self._tasks.pop(task_id, None)
            return task

    async def pop(self, task_id: str, *, session_id: str) -> ShellTask:
        if self._coordinator.distributed:
            async with self._coordinator.lock(
                f"shell-task:{task_id}", timeout_seconds=5
            ):
                task = await self.get(task_id, session_id=session_id)
                await self._coordinator.client.delete(self._key(task_id))
                return task
        async with self._lock:
            task = self._get_local(task_id, session_id)
            self._tasks.pop(task_id, None)
            return task

    async def _get_unscoped(self, task_id: str) -> ShellTask | None:
        if self._coordinator.distributed:
            raw = await self._coordinator.client.get(self._key(task_id))
            if not isinstance(raw, (str, bytes)):
                return None
            try:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    return None
                return ShellTask._from_payload(payload)
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                return None
        async with self._lock:
            return self._tasks.get(task_id)

    async def _store_distributed(self, task: ShellTask) -> None:
        ttl_seconds = max(300, math.ceil(task.timeout_ms / 1000) + 60)
        await self._coordinator.client.set(
            self._key(task.id),
            json.dumps(task._payload(), ensure_ascii=False, separators=(",", ":")),
            ex=ttl_seconds,
        )

    def _get_local(self, task_id: str, session_id: str) -> ShellTask:
        task = self._tasks.get(task_id)
        if task is None or task.session_id != session_id:
            raise KeyError(task_id)
        return task

    @staticmethod
    def _require_connector(task: ShellTask, connector_id: str | None) -> None:
        if connector_id is not None and task.connector_id != connector_id:
            raise KeyError(task.id)

    @staticmethod
    def _matches(
        task: ShellTask | None,
        session_id: str,
        connector_id: str | None,
    ) -> bool:
        return bool(
            task is not None
            and task.session_id == session_id
            and (connector_id is None or task.connector_id == connector_id)
        )

    def _key(self, task_id: str) -> str:
        return self._coordinator.key("shell-task", task_id)

    def _channel(self, task_id: str) -> str:
        return self._coordinator.channel("shell-task", task_id)
