from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import subprocess
import sys
from pathlib import Path

from ..domain.definitions import AcpError, LaunchDefinition


class AgentProcess:
    def __init__(self):
        self.process: asyncio.subprocess.Process | None = None
        self.job = None
        self._stderr_task = None

    async def start(
        self, launch: LaunchDefinition, cwd: str
    ) -> asyncio.subprocess.Process:
        executable = Path(launch.executable)
        if not executable.is_absolute() or not executable.is_file():
            raise AcpError(
                "invalid_agent_executable", "Agent 需要已安装的绝对入口路径。"
            )
        environment = {
            key: value
            for key, value in os.environ.items()
            if not key.upper().startswith(
                (
                    "AGENT_",
                    "AGENTS_ANYWHERE",
                    "AA_",
                    "NODE_OPTIONS",
                    "NODE_INSPECT",
                    "ELECTRON_",
                )
            )
        }
        environment.update(dict(launch.environment))
        args = [str(executable), *launch.arguments]
        options = {}
        if sys.platform == "win32":
            from .windows import WindowsJob

            self.job = WindowsJob()
            # CREATE_SUSPENDED is not exported by Python's subprocess module.
            options["creationflags"] = 0x00000004 | subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            args = [
                sys.executable,
                str(Path(__file__).with_name("guardian.py")),
                str(os.getpid()),
                *args,
            ]
            options["start_new_session"] = True
        try:
            self.process = await asyncio.create_subprocess_exec(
                *args,
                cwd=cwd,
                env=environment,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=4 * 1024 * 1024,
                **options,
            )
            if self.job:
                self.job.assign_and_resume(self.process.pid)
            self._stderr_task = asyncio.create_task(self._drain_stderr())
            return self.process
        except BaseException:
            await self.close()
            raise

    async def _drain_stderr(self):
        # Drain without retaining credentials or arbitrary extension diagnostics.
        while (
            self.process
            and self.process.stderr
            and await self.process.stderr.read(65536)
        ):
            pass

    async def close(self):
        if self.job:
            self.job.close()
            self.job = None
        proc = self.process
        if proc and proc.returncode is None:
            if proc.stdin:
                proc.stdin.close()
            with contextlib.suppress(ProcessLookupError):
                if sys.platform == "win32":
                    proc.kill()
                else:
                    os.killpg(proc.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(proc.wait(), 2)
            except TimeoutError:
                with contextlib.suppress(ProcessLookupError):
                    if sys.platform == "win32":
                        proc.kill()
                    else:
                        os.killpg(proc.pid, signal.SIGKILL)
                await proc.wait()
        if self._stderr_task:
            await self._stderr_task
