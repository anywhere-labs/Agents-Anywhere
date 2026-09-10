from __future__ import annotations

import base64
import binascii
from typing import Any

from loguru import logger

from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.infra.terminal_stream_hub import TerminalStreamHub
from agent_server.services.shell_tasks import ShellTaskManager


class ConnectorRealtimeService:
    def __init__(
        self,
        tasks: ShellTaskManager,
        terminal_broker: TerminalBroker,
        terminal_stream_hub: TerminalStreamHub,
    ) -> None:
        self._tasks = tasks
        self._terminal_broker = terminal_broker
        self._terminal_stream_hub = terminal_stream_hub

    async def apply(
        self,
        *,
        connector_id: str,
        method: str,
        params: dict[str, Any],
    ) -> bool:
        if method == "shell.task.started":
            await self._shell_task_started(connector_id, params)
        elif method == "shell.task.completed":
            await self._shell_task_completed(connector_id, params)
        elif method == "terminal.output":
            await self._terminal_output(connector_id, params)
        elif method == "terminal.exited":
            await self._terminal_exited(connector_id, params)
        else:
            return False
        return True

    async def _shell_task_started(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> None:
        task_id = params.get("taskId")
        session_id = params.get("sessionId")
        if not isinstance(task_id, str) or not isinstance(session_id, str):
            return
        try:
            await self._tasks.mark_running(
                task_id,
                session_id=session_id,
                connector_id=connector_id,
            )
        except KeyError:
            logger.warning(
                "ignored shell task started from mismatched connector task_id={} connector_id={}",
                task_id,
                connector_id,
            )

    async def _shell_task_completed(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> None:
        task_id = params.get("taskId")
        session_id = params.get("sessionId")
        status = params.get("status")
        if not isinstance(task_id, str) or not isinstance(session_id, str):
            return
        await self._tasks.complete(
            task_id,
            session_id=session_id,
            connector_id=connector_id,
            status=status
            if status in {"completed", "failed", "cancelled"}
            else "failed",
            result=params.get("result")
            if isinstance(params.get("result"), dict)
            else None,
            error=params.get("error")
            if isinstance(params.get("error"), dict)
            else None,
        )

    async def _terminal_output(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> None:
        await self._terminal_stream_hub.publish_output(connector_id, params)
        terminal_id = params.get("terminalId")
        data_b64 = params.get("dataBase64")
        seq = params.get("seq")
        if not (
            isinstance(terminal_id, str)
            and isinstance(data_b64, str)
            and isinstance(seq, int)
        ):
            return
        try:
            data = base64.b64decode(data_b64)
        except (binascii.Error, ValueError):
            data = b""
        if data:
            await self._terminal_broker.on_output(terminal_id, data=data, seq=seq)

    async def _terminal_exited(
        self,
        connector_id: str,
        params: dict[str, Any],
    ) -> None:
        await self._terminal_stream_hub.publish_exit(connector_id, params)
        terminal_id = params.get("terminalId")
        if not isinstance(terminal_id, str):
            return
        exit_code = params.get("exitCode")
        reason = params.get("reason") if isinstance(params.get("reason"), str) else None
        await self._terminal_broker.on_exited(
            terminal_id,
            exit_code=exit_code if isinstance(exit_code, int) else None,
            reason=reason,
        )
