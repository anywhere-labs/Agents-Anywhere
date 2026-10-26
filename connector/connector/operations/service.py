from __future__ import annotations

import asyncio

from meshcall import MeshCallError, mutates, query, service

from connector.mesh.hub import run_on_loop
from connector.operations.executor import OperationExecutor
from connector.operations.models import OperationRecord, OperationRequest, ProtocolInfo

SERVICE = "aa.remote.v1.Operations"


@service(SERVICE, targeted=True)
class OperationsService:
    """Persist, execute and reconcile runtime operations."""

    def __init__(
        self,
        executor: OperationExecutor,
        loop: asyncio.AbstractEventLoop,
        source: dict[str, str] | None = None,
    ) -> None:
        self.executor = executor
        self.loop = loop
        self.source = source or {}

    def _validate_source(self, request: OperationRequest) -> None:
        if any(getattr(request, key) != value for key, value in self.source.items()):
            raise MeshCallError(
                "permission_denied", "Operation belongs to another source"
            )

    @query
    async def ping(self) -> ProtocolInfo:
        """Check the registered operations protocol without reading business data."""
        return ProtocolInfo()

    @mutates(idempotent=True)
    async def submit(self, request: OperationRequest) -> OperationRecord:
        """Persist reception and return before native execution finishes."""
        self._validate_source(request)
        return await run_on_loop(self.loop, self.executor.submit(request))

    @query
    async def get(self, operationId: str) -> OperationRecord | None:
        """Read a durable receipt without causing native side effects."""
        record = await run_on_loop(self.loop, self.executor.get(operationId))
        if record:
            self._validate_source(record.request)
        return record

    @mutates(idempotent=True)
    async def ackResult(self, operationId: str) -> OperationRecord | None:
        """Record upstream reception while retaining the deduplication receipt."""
        await self.get(operationId)
        return await run_on_loop(self.loop, self.executor.ack(operationId))


def bind_service(
    name: str,
    executor: OperationExecutor,
    loop: asyncio.AbstractEventLoop,
    source: dict[str, str] | None = None,
) -> OperationsService:
    # Never mutate the shared class contract: each connection has its own type.
    methods = {
        key: value
        for key, value in OperationsService.__dict__.items()
        if hasattr(value, "__meshcall_method__")
    }
    methods["__module__"] = __name__
    bound = service(name, targeted=True)(
        type("BoundOperationsService", (OperationsService,), methods)
    )
    return bound(executor, loop, source)
