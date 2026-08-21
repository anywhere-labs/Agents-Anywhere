from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, ClassVar

BackgroundScheduler = Callable[[Awaitable[Any]], None]
UploadPreparedDownload = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]
StartTerminalRelay = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


class LocalRpcHandler:
    """Routes backend RPC methods to local filesystem, shell, and terminal capabilities."""

    METHODS: ClassVar[set[str]] = {
        "fs.prepareDownload",
        "fs.uploadPreparedDownload",
        "fs.writeFile",
        "fs.readDir",
        "fs.readText",
        "shell.exec",
        "shell.task.start",
        "shell.task.cancel",
        "terminal.create",
        "terminal.write",
        "terminal.resize",
        "terminal.close",
        "terminal.rename",
        "terminal.list",
        "terminal.release",
        "terminal.snapshot",
        "terminal.relay.connect",
    }

    def __init__(
        self,
        local_ops: Any,
        upload_prepared_download: UploadPreparedDownload,
        start_terminal_relay: StartTerminalRelay,
        schedule_background: BackgroundScheduler,
    ) -> None:
        self.local_ops = local_ops
        self.upload_prepared_download = upload_prepared_download
        self.start_terminal_relay = start_terminal_relay
        self.schedule_background = schedule_background

    def supports(self, method: str) -> bool:
        return method in self.METHODS

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "fs.prepareDownload":
            return await self.local_ops.prepare_download(params)
        if method == "fs.uploadPreparedDownload":
            self.schedule_background(self.upload_prepared_download(params))
            return {"transferId": params.get("transferId"), "uploadStarted": True}
        if method == "fs.writeFile":
            return await self.local_ops.write_file(params)
        if method == "fs.readDir":
            return await self.local_ops.read_dir(params)
        if method == "fs.readText":
            return await self.local_ops.read_text(params)
        if method == "shell.exec":
            return await self.local_ops.shell_exec(params)
        if method == "shell.task.start":
            return await self.local_ops.shell_task_start(params)
        if method == "shell.task.cancel":
            return await self.local_ops.shell_task_cancel(params)
        if method == "terminal.create":
            return await self.local_ops.terminal_create(params)
        if method == "terminal.write":
            return await self.local_ops.terminal_write(params)
        if method == "terminal.resize":
            return await self.local_ops.terminal_resize(params)
        if method == "terminal.close":
            return await self.local_ops.terminal_close(params)
        if method == "terminal.rename":
            return await self.local_ops.terminal_rename(params)
        if method == "terminal.list":
            return await self.local_ops.terminal_list(params)
        if method == "terminal.release":
            return await self.local_ops.terminal_release(params)
        if method == "terminal.snapshot":
            return await self.local_ops.terminal_snapshot(params)
        if method == "terminal.relay.connect":
            return await self.start_terminal_relay(params)
        raise ValueError(f"unsupported local method: {method}")
