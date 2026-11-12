from __future__ import annotations

import asyncio


class SynchronizationService:
    def __init__(self, store, publish):
        self.store, self.publish = store, publish
        self.lock = asyncio.Lock()
        self.stopping = False
        self.task = None
        self.last_error: str | None = None

    def start(self):
        self.task = asyncio.create_task(self.run())

    async def flush(self):
        async with self.lock:
            while rows := self.store.pending():
                await self.publish([value for _, _, value in rows])
                with self.store.transaction():
                    self.store.acknowledge([key for _, key, _ in rows])

    async def run(self):
        while not self.stopping:
            try:
                await self.flush()
                self.last_error = None
            except Exception as error:  # noqa: BLE001 -- durable queue retains all unacknowledged facts
                self.last_error = type(error).__name__
            await asyncio.sleep(0.1 if self.last_error is None else 1)

    async def close(self):
        self.stopping = True
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
