"""Own SDK stop tasks through drain interruption and caller cancellation."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence

from meshcall import ReconnectPolicy, RouterCredentials, RpcServer
from meshcall.drivers.websocket import WebSocketRouterServerDriver


async def complete_cleanup(work) -> None:
    task = asyncio.ensure_future(work)
    cancellation = None
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as error:
            if task.cancelled():
                raise
            cancellation = error
    task.result()
    if cancellation is not None:
        raise cancellation


class _ControlRouterDriver(WebSocketRouterServerDriver):
    def __init__(self, url: str, token: str, instance_id: str) -> None:
        super().__init__(url, auth=RouterCredentials.bearer(token), instance_id=instance_id,
                         reconnect=ReconnectPolicy(enabled=False))
        self.shutdown = asyncio.Event()

    async def start(self, binding, runtime) -> None:
        try:
            await super().start(binding, runtime)
        except BaseException:
            # RpcServer releases this binding on start failure but does not
            # stop a partially registered driver. Close while it is still valid.
            await complete_cleanup(super().stop(binding))
            raise

    async def drain(self, binding, runtime, *, timeout: float) -> None:
        # Returning normally lets RpcServer.stop finish driver/worker cleanup.
        # Cancelling RpcServer.stop during its drain would skip those steps.
        draining = asyncio.create_task(super().drain(binding, runtime, timeout=timeout))
        stopping = asyncio.create_task(self.shutdown.wait())
        try:
            done, _ = await asyncio.wait({draining, stopping}, return_when=asyncio.FIRST_COMPLETED)
            if draining in done:
                await draining
        finally:
            for task in (draining, stopping):
                task.cancel()
            await asyncio.gather(draining, stopping, return_exceptions=True)


class ControlMeshServer:
    """One registration, one owned stop task, and an interruptible drain wait."""

    def __init__(self, url: str, token: str, instance_id: str, services: Sequence[object]) -> None:
        self.server = RpcServer(services=services, driver=_ControlRouterDriver(url, token, instance_id), access_log=False)
        self._start: asyncio.Task | None = None
        self._start_cancelled = False
        self._stop: asyncio.Task | None = None

    async def start(self) -> ControlMeshServer:
        if self.server.driver.shutdown.is_set():
            raise ConnectionError("Connector Mesh server is closing")
        if self._start is None:
            self._start = asyncio.create_task(self.server.start(), name="connector-mesh-start")
        try:
            await asyncio.shield(self._start)
        except BaseException:
            self._cancel_start()
            await complete_cleanup(asyncio.gather(self._start, return_exceptions=True))
            raise
        return self

    def _cancel_start(self) -> None:
        if self._start is not None and not self._start.done() and not self._start_cancelled:
            self._start_cancelled = True
            self._start.cancel()

    async def _stop_once(self, *, drain: bool, timeout: float = 0) -> None:
        if self._stop is None:
            self._stop = asyncio.create_task(self.server.stop(drain=drain, drain_timeout=timeout),
                                             name="connector-mesh-stop")
        await asyncio.shield(self._stop)

    async def drain(self, timeout: float) -> None:
        await self._stop_once(drain=True, timeout=timeout)

    async def close(self) -> None:
        self.server.driver.shutdown.set()
        self._cancel_start()
        if self._start is not None:
            await complete_cleanup(asyncio.gather(self._start, return_exceptions=True))
        await self._stop_once(drain=False)
