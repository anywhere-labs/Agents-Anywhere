from __future__ import annotations

import sys
from typing import Any

from connector.local.common import Notify
from connector.local.file_ops import FileOps
from connector.local.shell import ShellBackend, UnixShellBackend, WindowsShellBackend
from connector.local.terminal import TerminalBackend, default_terminal_backend


class LocalOps:
    def __init__(
        self,
        *,
        files: FileOps,
        shell: ShellBackend,
        terminal: TerminalBackend,
    ) -> None:
        self.files = files
        self.shell = shell
        self.terminal = terminal

    @property
    def notify(self) -> Notify | None:
        return self.shell.notify

    @notify.setter
    def notify(self, value: Notify | None) -> None:
        self.shell.notify = value
        self.terminal.notify = value

    async def prepare_download(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.files.prepare_download(params)

    def prepared_download_path(self, params: dict[str, Any]) -> str:
        return self.files.prepared_download_path(params)

    async def write_file(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.files.write_file(params)

    async def read_text(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.files.read_text(params)

    async def read_dir(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.files.read_dir(params)

    async def shell_exec(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.shell.exec(params)

    async def shell_task_start(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.shell.task_start(params)

    async def shell_task_cancel(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.shell.task_cancel(params)

    async def terminal_create(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.terminal.create(params)

    async def terminal_write(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.terminal.write(params)

    async def terminal_resize(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.terminal.resize(params)

    async def terminal_close(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.terminal.close(params)

    async def terminal_list(self, params: dict[str, Any]) -> dict[str, Any]:
        return await self.terminal.list(params)


def create_local_ops(
    notify: Notify | None = None,
) -> LocalOps:
    files = FileOps()
    shell: ShellBackend
    if sys.platform == "win32":
        shell = WindowsShellBackend(notify=notify)
    else:
        shell = UnixShellBackend(notify=notify)
    terminal = default_terminal_backend(notify=notify)
    return LocalOps(files=files, shell=shell, terminal=terminal)
