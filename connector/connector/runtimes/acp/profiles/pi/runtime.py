"""Asynchronous environment preparation around the shared ACP Runtime."""
from __future__ import annotations

import asyncio
from dataclasses import replace

from ...domain.definitions import AcpError
from ...runtime import AcpRuntime


class ManagedPiRuntime(AcpRuntime):
    def __init__(self, *args, prepare_launch, **kwargs):
        super().__init__(*args, **kwargs)
        self.prepare_launch = prepare_launch
        self.startup_task = None
        self.startup_error = None
        self.ready = False

    async def health(self, status, **kwargs):
        report = getattr(self.host, "runtime_health_update", None)
        if report:
            await report(status, **kwargs)

    async def start(self):
        # Return promptly: a first Node/npm download can exceed the control RPC
        # timeout. The normal Runtime status stream owns progress and completion.
        await self.health("starting", phase={"stage": "installing", "message": "正在准备 Pi 运行环境…"})
        self.startup_task = asyncio.create_task(self.initialize())

    async def initialize(self):
        try:
            self.launch = await self.prepare_launch()
            self.app.launch = self.launch
            await super().start()
            self.ready = True
            await self.health("running")
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 -- report installation failure without credentials
            self.startup_error = error
            await self.health("error", error={"code": getattr(error, "code", "pi_environment_failed"),
                                             "message": str(error) if isinstance(error, AcpError) else "Pi 运行环境准备失败，请检查配置和网络后重试。"})

    async def wait_ready(self):
        await self.startup_task
        if self.startup_error:
            raise self.startup_error

    async def get_runtime_capabilities(self):
        value = await super().get_runtime_capabilities()
        return replace(value, capabilities=tuple(replace(cap, available=cap.available and self.ready) for cap in value.capabilities))

    async def stop(self):
        if self.startup_task and not self.startup_task.done():
            self.startup_task.cancel()
            await asyncio.gather(self.startup_task, return_exceptions=True)
        await super().stop()
        self.ready = False
