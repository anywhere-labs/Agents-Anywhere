"""The Connector's side of the DSH bridge on its local Router.

The DSH plugin finds this process through the rendezvous file published here
(the Router endpoint and the ``dsh-bridge`` key), registers
``aa.dsh.v2.Bridge`` on the Router and calls ``aa.dsh.v2.Sync`` back to hand
over event batches. A batch is acknowledged by the call returning, after every
operation in it has been ingested.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any, Protocol

from meshcall import MeshCallError, RpcInputStream, mutates, query, service
from pydantic import BaseModel, ConfigDict, Field

from connector.logging import logger
from connector.mesh.hub import (
    DSH_BRIDGE_ROLE,
    DSH_SYNC_SERVICE,
    LocalHub,
    local_hub,
    run_on_loop,
    write_private_json,
)
from connector.runtimes.dsh import provider_config

RENDEZVOUS_VERSION = 2
# Application error: the request names a subscription this process does not run.
SUBSCRIPTION_UNKNOWN = "subscription_unknown"


class SyncBatch(BaseModel):
    subscriptionId: str
    batchSeq: int = Field(ge=1)
    projectionVersion: int
    operations: list[dict[str, Any]] = Field(min_length=1)


class IngestResult(BaseModel):
    ok: bool = True


class CheckpointResult(BaseModel):
    checkpoint: dict[str, Any] | None = None


class SnapshotRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    captureId: str = Field(min_length=1, max_length=128)
    subscriptionId: str
    sessionId: str
    meta: dict[str, Any]
    throughSeq: int


class SnapshotPage(BaseModel):
    captureId: str = Field(min_length=1, max_length=128)
    items: list[dict[str, Any]] = Field(min_length=1)


class SnapshotResult(BaseModel):
    """``accepted`` is false for a permanently refused capture (the session is quarantined)."""

    accepted: bool
    quarantined: bool = False
    reason: str | None = None


class SyncSubscriber(Protocol):
    async def ingest(self, batch: SyncBatch) -> None: ...

    async def load_checkpoint(self, external_session_id: str) -> dict[str, Any] | None: ...

    async def save_checkpoint(self, external_session_id: str, checkpoint: dict[str, Any]) -> None: ...

    async def delete_checkpoint(self, external_session_id: str) -> None: ...

    async def begin_snapshot(self, request: SnapshotRequest) -> None: ...

    async def add_snapshot_page(self, page: SnapshotPage) -> None: ...

    async def commit_snapshot(self, capture_id: str) -> SnapshotResult: ...

    async def abort_snapshot(self, capture_id: str) -> None: ...


class SubscriptionRegistry:
    def __init__(self) -> None:
        self._subscribers: dict[str, SyncSubscriber] = {}

    def add(self, subscription_id: str, subscriber: SyncSubscriber) -> None:
        self._subscribers[subscription_id] = subscriber

    def remove(self, subscription_id: str, subscriber: SyncSubscriber) -> None:
        if self._subscribers.get(subscription_id) is subscriber:
            del self._subscribers[subscription_id]

    def get(self, subscription_id: str) -> SyncSubscriber | None:
        return self._subscribers.get(subscription_id)


@service(DSH_SYNC_SERVICE, description="Event batches and checkpoints from the DSH plugin.")
class SyncService:
    def __init__(self, registry: SubscriptionRegistry, loop: asyncio.AbstractEventLoop) -> None:
        self._registry = registry
        self._loop = loop

    def _subscriber(self, subscription_id: str) -> SyncSubscriber:
        subscriber = self._registry.get(subscription_id)
        if subscriber is None:
            raise MeshCallError(SUBSCRIPTION_UNKNOWN, "The Connector no longer runs this sync subscription")
        return subscriber

    async def _call[T](self, work: Callable[[SyncSubscriber], Awaitable[T]], subscription_id: str) -> T:
        subscriber = self._subscriber(subscription_id)
        return await run_on_loop(self._loop, work(subscriber))

    async def _serialized[T](self, work: Callable[[SyncSubscriber], Awaitable[T]], subscription_id: str) -> T:
        subscriber = self._subscriber(subscription_id)
        return await run_on_loop(self._loop, subscriber.serialized(lambda: work(subscriber)))

    @mutates(idempotent=True)
    async def ingestBatch(self, batch: SyncBatch) -> IngestResult:
        """Ingest one batch of a subscription; returning is its acknowledgement."""
        await self._call(lambda subscriber: subscriber.ingest(batch), batch.subscriptionId)
        return IngestResult()

    @query
    async def loadCheckpoint(self, subscriptionId: str, externalSessionId: str) -> CheckpointResult:
        """The checkpoint the Connector stored for one native session."""
        checkpoint = await self._serialized(
            lambda subscriber: subscriber.load_checkpoint(externalSessionId), subscriptionId,
        )
        return CheckpointResult(checkpoint=checkpoint)

    @mutates(idempotent=True)
    async def saveCheckpoint(
        self, subscriptionId: str, externalSessionId: str, checkpoint: dict[str, Any],
    ) -> IngestResult:
        """Store a checkpoint; withheld for a quarantined session."""
        await self._serialized(
            lambda subscriber: subscriber.save_checkpoint(externalSessionId, checkpoint), subscriptionId,
        )
        return IngestResult()

    @mutates(idempotent=True)
    async def deleteCheckpoint(self, subscriptionId: str, externalSessionId: str) -> IngestResult:
        """Drop a checkpoint; the next baseline is a full capture."""
        await self._serialized(
            lambda subscriber: subscriber.delete_checkpoint(externalSessionId), subscriptionId,
        )
        return IngestResult()

    @mutates(idempotent=True)
    async def ingestSnapshot(
        self, request: SnapshotRequest, items: RpcInputStream[SnapshotPage],
    ) -> SnapshotResult:
        """Assemble a paged snapshot; the call returning means it was stored or quarantined."""
        subscriber = self._subscriber(request.subscriptionId)
        await self._serialized(lambda _s: _s.begin_snapshot(request), request.subscriptionId)
        try:
            async for page in items:
                await self._serialized(lambda _s, page=page: _s.add_snapshot_page(page), request.subscriptionId)
            return await self._serialized(
                lambda _s: _s.commit_snapshot(request.captureId), request.subscriptionId,
            )
        except BaseException:
            # The call is cancelled here, so schedule the abort instead of awaiting it.
            with contextlib.suppress(Exception):
                future = asyncio.run_coroutine_threadsafe(
                    subscriber.serialized(lambda: subscriber.abort_snapshot(request.captureId)),
                    self._loop,
                )
                future.add_done_callback(lambda done: done.exception())
            raise


def rendezvous_path() -> Path:
    return provider_config.endpoint_path()


def read_rendezvous(path: Path | None = None) -> dict[str, Any]:
    raw = json.loads((path or rendezvous_path()).read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("version") != RENDEZVOUS_VERSION:
        raise ValueError("DSH rendezvous has an unsupported version")
    return raw


class BridgeHost:
    """Per Router: the Sync service, its subscriptions and the published rendezvous."""

    def __init__(self, hub: LocalHub) -> None:
        self.hub = hub
        self.registry = SubscriptionRegistry()
        self._mounted = False
        self._published: Path | None = None

    async def start(self) -> None:
        if not self._mounted:
            await self.hub.mount(SyncService(self.registry, asyncio.get_running_loop()))
            self._mounted = True
        self.publish()

    def publish(self) -> None:
        path = rendezvous_path()
        write_private_json(path, {
            "version": RENDEZVOUS_VERSION,
            "protocol": "meshcall",
            **self.hub.descriptor(DSH_BRIDGE_ROLE),
        })
        self._published = path
        logger.info("published DSH bridge rendezvous path={}", path)

    async def stop(self) -> None:
        if self._published is not None:
            # Another Connector may have replaced it since; leave theirs alone.
            with contextlib.suppress(OSError, ValueError):
                if read_rendezvous(self._published).get("instanceId") == self.hub.instance_id:
                    self._published.unlink()
            self._published = None


_hosts: dict[int, BridgeHost] = {}


async def bridge_host() -> BridgeHost:
    """The DSH bridge services of this process's Router, started on first use."""
    hub = await local_hub()
    host = _hosts.get(id(hub))
    if host is None:
        host = _hosts[id(hub)] = BridgeHost(hub)
        hub.on_stop(_forget(hub, host))
    await host.start()
    return host


def _forget(hub: LocalHub, host: BridgeHost) -> Callable[[], Awaitable[None]]:
    async def stop() -> None:
        _hosts.pop(id(hub), None)
        await host.stop()

    return stop


async def iter_pages(pages: AsyncIterator[SnapshotPage]) -> AsyncIterator[SnapshotPage]:
    """Pass-through for callers that want to name the stream type."""
    async for page in pages:
        yield page
