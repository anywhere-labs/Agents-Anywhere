"""Bounded, best-effort diagnostic delivery, independent of business scheduling."""

from __future__ import annotations

import asyncio
import inspect
import json
import sys
import threading
import time
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future
from datetime import UTC, datetime
from typing import Any


class QueuedLogWriter:
    def __init__(
        self, notifier: Callable, *, batch_notifier: Callable | None = None,
        capacity: int = 1024, byte_capacity: int = 4 * 1024 * 1024,
        batch_size: int = 64, close_timeout: float = 2.0,
        on_stopped: Callable[[], None] | None = None,
    ) -> None:
        if min(capacity, byte_capacity, batch_size) <= 0 or close_timeout < 0:
            raise ValueError("invalid diagnostic queue limits")
        self._notifier, self._batch_notifier = notifier, batch_notifier
        self._capacity, self._byte_capacity = capacity, byte_capacity
        self._batch_size, self._close_timeout = batch_size, close_timeout
        self._on_stopped = on_stopped
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None
        self._condition = threading.Condition()
        self._queue: deque[tuple[dict[str, Any], int]] = deque()
        self._bytes = 0
        self._closing = False
        self._abandon = False
        self._pending: Future | None = None
        self._counts = {"enqueued": 0, "written": 0, "dropped": 0, "failed": 0}
        self._reported = (0, 0)
        # A stuck filesystem/notifier must not hold interpreter shutdown open.
        self._thread = threading.Thread(target=self._run, name="connector-log-writer", daemon=True)
        self._thread.start()

    @property
    def statistics(self) -> dict[str, int]:
        with self._condition:
            return {**self._counts, "pending": len(self._queue), "pendingBytes": self._bytes}

    def write(self, payload: dict[str, Any]) -> None:
        size = len(json.dumps(payload, ensure_ascii=False).encode())
        with self._condition:
            if self._closing or len(self._queue) >= self._capacity or self._bytes + size > self._byte_capacity:
                self._counts["dropped"] += 1
                return
            self._queue.append((payload, size))
            self._bytes += size
            self._counts["enqueued"] += 1
            self._condition.notify()

    async def close(self) -> bool:
        with self._condition:
            self._closing = True
            self._condition.notify()
        end = time.monotonic() + self._close_timeout
        while self._thread.is_alive() and time.monotonic() < end:
            await asyncio.sleep(min(0.005, max(0, end - time.monotonic())))
        if not self._thread.is_alive():
            return True
        with self._condition:
            self._abandon = True
            self._counts["dropped"] += len(self._queue)
            self._queue.clear()
            self._bytes = 0
            pending = self._pending
        if pending is not None:
            pending.cancel()
        # An in-flight synchronous write cannot safely be killed. It stays on
        # the daemon; on_stopped closes its store only after that write returns.
        return False

    def _invoke(self, callback: Callable, *args) -> None:
        with self._condition:
            if self._abandon:
                raise RuntimeError("diagnostic flush deadline expired")
        result = callback(*args)
        if not inspect.isawaitable(result):
            return

        async def deliver():
            return await result

        if self._loop is None or self._loop.is_closed():
            if inspect.iscoroutine(result):
                result.close()
            raise RuntimeError("async diagnostic notifier has no live event loop")
        delivery = deliver()
        try:
            pending = asyncio.run_coroutine_threadsafe(delivery, self._loop)
        except RuntimeError:
            delivery.close()
            if inspect.iscoroutine(result):
                result.close()
            raise
        with self._condition:
            self._pending = pending
            if self._abandon:
                pending.cancel()
        try:
            pending.result()
        finally:
            with self._condition:
                self._pending = None

    def _deliver(self, records: list[dict[str, Any]]) -> None:
        groups = [records] if self._batch_notifier is not None else [[record] for record in records]
        for index, group in enumerate(groups):
            with self._condition:
                if self._abandon:
                    self._counts["dropped"] += sum(len(tail) for tail in groups[index:])
                    break
            try:
                if self._batch_notifier is not None:
                    self._invoke(self._batch_notifier, group)
                else:
                    self._invoke(self._notifier, "connector/log", group[0])
            except Exception:  # noqa: BLE001 - diagnostic backends cannot fail business calls
                with self._condition:
                    self._counts["failed"] += len(group)
            else:
                with self._condition:
                    self._counts["written"] += len(group)

    def _report_loss(self) -> None:
        counts = self.statistics
        changed = (counts["dropped"], counts["failed"])
        if changed == self._reported:
            return
        payload = {"time": datetime.now(UTC).isoformat(), "level": "WARNING", "name": "connector.logging",
                   "message": "Diagnostic log records lost",
                   "details": json.dumps({"logSink": counts})}
        try:
            if self._batch_notifier is not None:
                self._invoke(self._batch_notifier, [payload])
            else:
                self._invoke(self._notifier, "connector/log", payload)
        except Exception:  # noqa: BLE001 - retry the loss summary after backend recovery
            return  # Keep the watermark, so recovery reports the accumulated loss.
        self._reported = changed

    def _run(self) -> None:
        try:
            while True:
                with self._condition:
                    self._condition.wait_for(lambda: self._queue or self._closing)
                    if not self._queue:
                        break
                    batch = []
                    for _ in range(min(self._batch_size, len(self._queue))):
                        payload, size = self._queue.popleft()
                        self._bytes -= size
                        batch.append(payload)
                self._deliver(batch)
                self._report_loss()
            self._report_loss()
            counts = self.statistics
            if (counts["dropped"], counts["failed"]) != self._reported:
                # Worker-only fallback: no user payloads, logger recursion or
                # synchronous stderr operation on the application event loop.
                sys.stderr.write(f"connector diagnostic logs lost dropped={counts['dropped']} failed={counts['failed']}\n")
        finally:
            if self._on_stopped is not None:
                try:
                    self._on_stopped()
                except Exception:  # noqa: BLE001 - a diagnostic store close cannot fail shutdown
                    sys.stderr.write("connector diagnostic store close failed\n")
