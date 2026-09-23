"""Bounded offload for large, pure outbound event transformations."""

from __future__ import annotations

import asyncio
import multiprocessing
from concurrent.futures import ProcessPoolExecutor

from agent_server.infra.shared_message import (
    PreparedSessionEvent,
    prepare_session_events,
)


class EventPreparationCapacityError(RuntimeError):
    pass


class EventPreparationPool:
    def __init__(
        self,
        *,
        workers: int = 2,
        threshold_bytes: int = 256 * 1024,
        max_pending: int = 32,
        max_pending_bytes: int = 32 * 1024 * 1024,
    ) -> None:
        if min(workers, threshold_bytes, max_pending, max_pending_bytes) < 1:
            raise ValueError("event preparation limits must be positive")
        self._workers = workers
        self._threshold_bytes = threshold_bytes
        self._max_pending = max_pending
        self._max_pending_bytes = max_pending_bytes
        self._slots = asyncio.Semaphore(workers)
        self._executor: ProcessPoolExecutor | None = None
        self._closing = False
        self.pending = 0
        self.pending_bytes = 0

    async def start(self) -> None:
        if self._executor is not None:
            return
        if self._closing:
            raise RuntimeError("event preparation pool is closing")
        self._executor = ProcessPoolExecutor(
            max_workers=self._workers,
            mp_context=multiprocessing.get_context("spawn"),
        )
        loop = asyncio.get_running_loop()
        await asyncio.gather(
            *(
                loop.run_in_executor(self._executor, prepare_session_events, "null")
                for _ in range(self._workers)
            )
        )

    async def prepare(self, message: str) -> tuple[PreparedSessionEvent, ...]:
        # Skip even the byte-size copy for clearly small Unicode messages.
        if len(message) < self._threshold_bytes // 4:
            return prepare_session_events(message)
        size = len(message.encode("utf-8"))
        if size < self._threshold_bytes:
            return prepare_session_events(message)
        if self._closing or self._executor is None:
            raise EventPreparationCapacityError("event preparation is unavailable")
        if (
            self.pending >= self._max_pending
            or self.pending_bytes + size > self._max_pending_bytes
        ):
            raise EventPreparationCapacityError("event preparation capacity exceeded")

        # Admission covers waiting jobs as well as submitted work. Rejected
        # sockets recover through the existing snapshot/reconnect protocol.
        self.pending += 1
        self.pending_bytes += size
        acquired = submitted = False
        try:
            await self._slots.acquire()
            acquired = True
            # Shutdown can begin while this job is waiting for a worker. Never
            # pass None to run_in_executor: that would use the default threads.
            if self._closing or self._executor is None:
                raise EventPreparationCapacityError("event preparation is unavailable")
            future = asyncio.get_running_loop().run_in_executor(
                self._executor,
                prepare_session_events,
                str(message),
            )
            submitted = True

            def completed(done: asyncio.Future) -> None:
                self._slots.release()
                self.pending -= 1
                self.pending_bytes -= size
                if not done.cancelled():
                    done.exception()

            future.add_done_callback(completed)
            # Cancellation must not make a still-running process job appear
            # free. Its completion callback owns capacity release.
            return await asyncio.shield(future)
        finally:
            if not submitted:
                if acquired:
                    self._slots.release()
                self.pending -= 1
                self.pending_bytes -= size

    async def close(self) -> None:
        self._closing = True
        executor, self._executor = self._executor, None
        if executor is not None:
            await asyncio.to_thread(executor.shutdown, wait=True, cancel_futures=True)
