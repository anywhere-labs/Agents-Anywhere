from __future__ import annotations

import asyncio

from loguru import logger

from agent_server.services.connector_rpc import ConnectorRpcPort, ConnectorServiceError
from agent_server.services.shell_tasks import ShellTask, ShellTaskManager


class ConnectorShellTaskNotFoundError(KeyError):
    pass


class ConnectorShellTaskTimeoutError(TimeoutError):
    pass


class ConnectorShellService:
    def __init__(
        self,
        gateway: ConnectorRpcPort,
        tasks: ShellTaskManager,
    ) -> None:
        self._gateway = gateway
        self._tasks = tasks

    async def exec(
        self,
        *,
        connector_id: str,
        scope_id: str,
        root: str,
        cwd: str,
        command: str,
        timeout_ms: int,
    ) -> object:
        return await self._gateway.request(
            connector_id,
            "shell.exec",
            {
                "sessionId": scope_id,
                "root": root,
                "cwd": cwd,
                "command": command,
                "timeoutMs": timeout_ms,
            },
            timeout=min((timeout_ms / 1000) + 5, 310),
        )

    async def start(
        self,
        *,
        connector_id: str,
        scope_id: str,
        root: str,
        cwd: str,
        command: str,
        timeout_ms: int,
    ) -> ShellTask:
        task = await self._tasks.create(
            session_id=scope_id,
            connector_id=connector_id,
            command=command,
            cwd=cwd,
            timeout_ms=timeout_ms,
        )
        try:
            await self._gateway.request(
                connector_id,
                "shell.task.start",
                {
                    "taskId": task.id,
                    "sessionId": scope_id,
                    "root": root,
                    "cwd": cwd,
                    "command": command,
                    "timeoutMs": timeout_ms,
                },
                timeout=10,
            )
        except ConnectorServiceError:
            await self._tasks.abandon(task.id, session_id=scope_id)
            raise
        return await self._tasks.mark_running(
            task.id,
            session_id=scope_id,
            connector_id=connector_id,
        )

    async def wait(
        self,
        *,
        scope_id: str,
        task_id: str,
        timeout_seconds: float,
    ) -> ShellTask:
        try:
            task = await self._tasks.get(task_id, session_id=scope_id)
        except KeyError as exc:
            raise ConnectorShellTaskNotFoundError(task_id) from exc
        try:
            await self._tasks.wait(
                task.id,
                session_id=scope_id,
                timeout_seconds=timeout_seconds,
            )
        except TimeoutError as exc:
            await self._abandon(scope_id, task)
            raise ConnectorShellTaskTimeoutError(task_id) from exc
        except asyncio.CancelledError:
            await self._abandon(scope_id, task)
            raise
        return await self._tasks.pop(task.id, session_id=scope_id)

    async def _abandon(self, scope_id: str, task: ShellTask) -> None:
        abandoned = await self._tasks.abandon(task.id, session_id=scope_id)
        if abandoned is None:
            return
        try:
            await self._gateway.request(
                task.connector_id,
                "shell.task.cancel",
                {"taskId": task.id, "sessionId": scope_id},
                timeout=5,
            )
        except ConnectorServiceError:
            logger.warning(
                "failed to cancel abandoned connector shell task task_id={} connector_id={}",
                task.id,
                task.connector_id,
            )
