from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable

from meshcall import MeshCallError

from connector.logging import logger
from connector.operations.models import (
    OperationRecord,
    OperationRequest,
    OperationResult,
)
from connector.operations.store import OperationStore
from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
    RuntimeUnsupportedError,
)

Handler = Callable[[OperationRequest, bool], Awaitable[OperationResult]]
TERMINAL = frozenset({"succeeded", "failed", "unknown"})


class OperationExecutor:
    def __init__(
        self,
        store: OperationStore,
        execute: Handler,
        acknowledge: Callable[[OperationRequest], Awaitable[None]] | None = None,
        prepare: Callable[[OperationRequest], Awaitable[None]] | None = None,
    ) -> None:
        self.store = store
        self.execute = execute
        self.acknowledge = acknowledge
        self.prepare = prepare
        self.lock = asyncio.Lock()
        self.slots = asyncio.Semaphore(4)
        self.resources: dict[str, asyncio.Lock] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.started = False

    async def start(self) -> None:
        if self.started:
            return
        # Read every receipt before accepting work; corruption must fail closed.
        records = self.store.records()
        self.started = True
        for record in records:
            if record.status in {"accepted", "queued", "running", "reconciling"}:
                self._schedule(record, record.status in {"running", "reconciling"})

    def _schedule(self, record: OperationRecord, recover: bool = False) -> None:
        operation_id = record.request.operationId
        if operation_id not in self.tasks:
            task = asyncio.create_task(
                self._run(record, recover), name=f"operation-{operation_id}"
            )
            self.tasks[operation_id] = task

            def done(finished: asyncio.Task[None]) -> None:
                self.tasks.pop(operation_id, None)
                # Observe persistence errors; the last durable stage drives recovery.
                if not finished.cancelled():
                    error = finished.exception()
                    if error is not None:
                        logger.error(
                            "operation worker failed operation_id={} error_type={}",
                            operation_id,
                            type(error).__name__,
                        )

            task.add_done_callback(done)

    async def submit(self, request: OperationRequest) -> OperationRecord:
        async with self.lock:
            await self.start()
            old = self.store.read(request.operationId)
            if old is not None:
                if old.request.fingerprint() != request.fingerprint():
                    raise MeshCallError(
                        "operation_conflict", "Operation ID has different parameters"
                    )
                if old.status in {"accepted", "queued"}:
                    self._schedule(old)
                return old
            if len(self.tasks) >= 256:
                raise MeshCallError("resource_exhausted", "Operation queue is full")
            record = OperationRecord(request=request, status="accepted")
            self.store.write(record)
            self._schedule(record)
            return record

    async def get(self, operation_id: str) -> OperationRecord | None:
        async with self.lock:
            await self.start()
            record = self.store.read(operation_id)
            if record is not None and record.status in {
                "accepted",
                "queued",
                "reconciling",
                "unknown",
            }:
                self._schedule(record, record.status in {"reconciling", "unknown"})
            return record

    async def ack(self, operation_id: str) -> OperationRecord | None:
        async with self.lock:
            record = self.store.read(operation_id)
            if record is not None and record.status in TERMINAL:
                record.resultReceived = True
                self.store.write(record)
        # This hop is already durable before confirming result reception downstream.
        # Failure propagates so the Server retries the idempotent ACK.
        if (
            record is not None
            and record.status in TERMINAL
            and self.acknowledge is not None
        ):
            await self.acknowledge(record.request)
        return record

    async def _run(self, record: OperationRecord, recover: bool) -> None:
        resource = self.resources.setdefault(record.request.runtimeId, asyncio.Lock())
        async with resource, self.slots:
            if self.prepare is not None:
                try:
                    await self.prepare(record.request)
                except (RuntimeInvalidRequestError, RuntimeUnsupportedError) as error:
                    record.status = "unknown" if recover else "failed"
                    record.message = str(error)
                    self.store.write(record)
                    return
                except RuntimeUnavailableError as error:
                    # Runtime activation after a Connector restart can lag registration.
                    # No native call began: retain acceptance and resume on a later query.
                    record.status = "reconciling" if recover else "accepted"
                    record.message = str(error)
                    self.store.write(record)
                    return
            record.message = None
            record.status = "reconciling" if recover else "running"
            self.store.write(record)
            try:
                result = await self.execute(record.request, recover)
            except (RuntimeInvalidRequestError, RuntimeUnsupportedError) as error:
                record.status = "unknown" if recover else "failed"
                record.message = str(error)
            except asyncio.CancelledError:
                # running is durable: a future process must reconcile, never blindly retry.
                raise
            except Exception as error:  # noqa: BLE001 - native errors may leave an unknown side effect
                record.status = "unknown"
                record.message = str(error)
            else:
                record.status = "succeeded"
                record.result = result
            self.store.write(record)

    async def close(self) -> None:
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
