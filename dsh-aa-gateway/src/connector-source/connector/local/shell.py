from __future__ import annotations

import asyncio
import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Any

from connector.local.common import (
    Notify,
    required_int,
    required_string,
    resolve_path,
    shell_result,
    workspace_root,
)


class ShellBackend:
    def __init__(self, notify: Notify | None = None) -> None:
        self.notify = notify
        self._shell_tasks: dict[str, dict[str, Any]] = {}

    async def exec(self, params: dict[str, Any]) -> dict[str, Any]:
        root = workspace_root(params)
        cwd = resolve_path(root, required_string(params, "cwd"))
        if not cwd.is_dir():
            raise NotADirectoryError(f"cwd not found: {cwd}")
        command = required_string(params, "command")
        timeout_ms = required_int(params, "timeoutMs")
        if timeout_ms <= 0:
            raise ValueError("timeoutMs must be positive")

        start = time.monotonic()
        process = await self._create_process(cwd, command)
        timed_out = False
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_ms / 1000)
        except TimeoutError:
            timed_out = True
            await self._terminate_process(process)
            stdout, stderr = await process.communicate()

        return shell_result(cwd, command, process.returncode, timed_out, start, stdout, stderr)

    async def task_start(self, params: dict[str, Any]) -> dict[str, Any]:
        root = workspace_root(params)
        cwd = resolve_path(root, required_string(params, "cwd"))
        if not cwd.is_dir():
            raise NotADirectoryError(f"cwd not found: {cwd}")
        task_id = required_string(params, "taskId")
        session_id = required_string(params, "sessionId")
        command = required_string(params, "command")
        timeout_ms = required_int(params, "timeoutMs")
        if timeout_ms <= 0:
            raise ValueError("timeoutMs must be positive")
        if task_id in self._shell_tasks:
            raise ValueError(f"shell task already exists: {task_id}")

        record: dict[str, Any] = {"process": None, "cancelled": False}
        background = asyncio.create_task(
            self._run_shell_task(
                task_id=task_id,
                session_id=session_id,
                cwd=cwd,
                command=command,
                timeout_ms=timeout_ms,
                record=record,
            )
        )
        record["background"] = background
        self._shell_tasks[task_id] = record
        await self._notify("shell.task.started", {"taskId": task_id, "sessionId": session_id, "status": "running"})
        return {"taskId": task_id, "sessionId": session_id, "status": "running"}

    async def task_cancel(self, params: dict[str, Any]) -> dict[str, Any]:
        task_id = required_string(params, "taskId")
        session_id = required_string(params, "sessionId")
        record = self._shell_tasks.get(task_id)
        if record is None:
            return {"taskId": task_id, "sessionId": session_id, "cancelled": False}
        record["cancelled"] = True
        await self._terminate_process(record.get("process"))
        background = record.get("background")
        if isinstance(background, asyncio.Task):
            background.cancel()
        self._shell_tasks.pop(task_id, None)
        await self._notify("shell.task.completed", {"taskId": task_id, "sessionId": session_id, "status": "cancelled"})
        return {"taskId": task_id, "sessionId": session_id, "cancelled": True}

    async def _run_shell_task(
        self,
        *,
        task_id: str,
        session_id: str,
        cwd: Path,
        command: str,
        timeout_ms: int,
        record: dict[str, Any],
    ) -> None:
        start = time.monotonic()
        timed_out = False
        stdout = b""
        stderr = b""
        process: asyncio.subprocess.Process | None = None
        try:
            process = await self._create_process(cwd, command)
            record["process"] = process
            try:
                stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_ms / 1000)
            except TimeoutError:
                timed_out = True
                await self._terminate_process(process)
                stdout, stderr = await process.communicate()
            result = shell_result(cwd, command, process.returncode, timed_out, start, stdout, stderr)
            await self._notify(
                "shell.task.completed",
                {"taskId": task_id, "sessionId": session_id, "status": "completed", "result": result},
            )
        except asyncio.CancelledError:
            if process is not None:
                await self._terminate_process(process)
            raise
        except Exception as exc:
            await self._notify(
                "shell.task.completed",
                {
                    "taskId": task_id,
                    "sessionId": session_id,
                    "status": "failed",
                    "error": {"code": exc.__class__.__name__, "message": str(exc)},
                },
            )
        finally:
            self._shell_tasks.pop(task_id, None)

    async def _create_process(self, cwd: Path, command: str) -> asyncio.subprocess.Process:
        raise NotImplementedError

    async def _terminate_process(self, process: Any) -> None:
        raise NotImplementedError

    async def _notify(self, method: str, params: dict[str, Any]) -> None:
        if self.notify is not None:
            await self.notify(method, params)


class UnixShellBackend(ShellBackend):
    async def _create_process(self, cwd: Path, command: str) -> asyncio.subprocess.Process:
        return await asyncio.create_subprocess_shell(
            command,
            cwd=str(cwd),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )

    async def _terminate_process(self, process: Any) -> None:
        if process is None or getattr(process, "returncode", None) is not None:
            return
        pid = getattr(process, "pid", None)
        if isinstance(pid, int):
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                return
            except OSError:
                process.terminate()
        else:
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=2)
        except TimeoutError:
            if isinstance(pid, int):
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    return
                except OSError:
                    process.kill()
            else:
                process.kill()
            await process.wait()


class WindowsShellBackend(ShellBackend):
    async def _create_process(self, cwd: Path, command: str) -> asyncio.subprocess.Process:
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        return await asyncio.create_subprocess_shell(
            command,
            cwd=str(cwd),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=creationflags,
        )

    async def _terminate_process(self, process: Any) -> None:
        if process is None or getattr(process, "returncode", None) is not None:
            return
        pid = getattr(process, "pid", None)
        if isinstance(pid, int):
            try:
                taskkill = await asyncio.create_subprocess_exec(
                    "taskkill",
                    "/T",
                    "/F",
                    "/PID",
                    str(pid),
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                await asyncio.wait_for(taskkill.wait(), timeout=5)
            except Exception:
                process.terminate()
        else:
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except TimeoutError:
            process.kill()
            await process.wait()
