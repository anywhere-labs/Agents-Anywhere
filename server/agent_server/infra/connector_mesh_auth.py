"""Worker-local credential cache with cross-worker invalidation, never grants."""

from __future__ import annotations

import asyncio
import json
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from redis.exceptions import RedisError

from agent_server.infra.connector_cleanup import complete_cleanup
from agent_server.infra.connector_control_log import control_log, error_fields
from agent_server.infra.redis_coordinator import RedisCoordinator

CREDENTIAL_CACHE_SECONDS = 30.0


@dataclass(eq=False)
class _Entry:
    value: str | None = None
    expires_at: float = 0
    invalidated: bool = False
    task: asyncio.Task | None = None
    waiters: int = 0


class ConnectorCredentialCache:
    def __init__(
        self, coordinator: RedisCoordinator, load: Callable[[str], Awaitable[str]],
        *, worker_id: str = "", ttl: float = CREDENTIAL_CACHE_SECONDS, capacity: int = 4096,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if ttl <= 0 or capacity < 1:
            raise ValueError("credential cache lifetime and capacity must be positive")
        self.coordinator, self.load = coordinator, load
        self.worker_id, self.ttl, self.capacity, self.clock = worker_id, ttl, capacity, clock
        self._entries: OrderedDict[str, _Entry] = OrderedDict()
        self._inflight: dict[str, _Entry] = {}
        self._loads: set[asyncio.Task] = set()
        self._listener: asyncio.Task | None = None
        self._pubsub = None
        self._start_lock = asyncio.Lock()
        self._closed = False
        self._closing: asyncio.Task | None = None
        self.healthy = not coordinator.distributed

    @property
    def channel(self) -> str:
        return self.coordinator.channel("connector", "credentials-changed")

    def invalidate_local(self, connector_id: str | None = None) -> None:
        if connector_id is None:
            entries = [*self._entries.values(), *self._inflight.values()]
            self._entries.clear()
            self._inflight.clear()
        else:
            entry = self._entries.pop(connector_id, None)
            loading = self._inflight.pop(connector_id, None)
            entries = [item for item in (entry, loading) if item is not None]
        for entry in entries:
            entry.invalidated = True
        control_log("auth.cache_invalidated", level="DEBUG", workerId=self.worker_id,
                    connectorId=connector_id, scope="connector" if connector_id else "worker")

    async def invalidate(self, connector_id: str) -> None:
        """Called after SQL commit, including direct repository credential changes."""
        self.invalidate_local(connector_id)
        if not self.coordinator.distributed:
            return
        try:
            async with asyncio.timeout(5):
                await self.coordinator.client.publish(self.channel, json.dumps({"connectorId": connector_id}))
        except (RedisError, OSError, TimeoutError) as error:
            # Do not skip the API's existing disconnect/relay cleanup after SQL
            # has committed. Cache expiry also bounds missed notifications.
            control_log("auth.invalidation_failed", level="WARNING", workerId=self.worker_id,
                        connectorId=connector_id, **error_fields(error))

    async def start(self) -> None:
        if self._closed:
            raise RedisError("credential cache is closed")
        if not self.coordinator.distributed or self._listener is not None:
            return
        async with self._start_lock:
            if self._closed:
                raise RedisError("credential cache is closed")
            if self._listener is None:
                await self._subscribe()
                if self._closed:
                    await complete_cleanup(self._close_subscription())
                    raise RedisError("credential cache is closed")
                self._listener = asyncio.create_task(self._listen(), name="mesh-credential-invalidations")
                self._listener.add_done_callback(self._listener_stopped)

    def _listener_stopped(self, task: asyncio.Task) -> None:
        self.healthy = False
        self.invalidate_local()
        if not task.cancelled() and (error := task.exception()) is not None:
            control_log("auth.subscription_stopped", level="WARNING", workerId=self.worker_id, **error_fields(error))

    async def _subscribe(self) -> None:
        self.healthy = False
        self.invalidate_local()
        self._pubsub = self.coordinator.client.pubsub()
        try:
            async with asyncio.timeout(5):
                await self._pubsub.subscribe(self.channel)
        except BaseException:
            await complete_cleanup(self._close_subscription())
            raise
        self.healthy = not self._closed

    async def _listen(self) -> None:
        while True:
            try:
                if self._pubsub is None:
                    await self._subscribe()
                async for event in self._pubsub.listen():
                    if event.get("type") == "subscribe":
                        # redis-py also emits this after an automatic reconnect.
                        self.invalidate_local()
                    elif event.get("type") == "message":
                        try:
                            connector_id = json.loads(event["data"]).get("connectorId")
                        except (ValueError, TypeError, AttributeError):
                            continue
                        if isinstance(connector_id, str) and connector_id:
                            self.invalidate_local(connector_id)
                raise RedisError("credential invalidation subscription ended")
            except asyncio.CancelledError:
                raise
            except (RedisError, OSError, TimeoutError) as error:
                self.healthy = False
                self.invalidate_local()
                control_log("auth.subscription_failed", level="WARNING", workerId=self.worker_id, **error_fields(error))
                await self._close_subscription()
                await asyncio.sleep(1)

    async def _close_subscription(self) -> None:
        pubsub, self._pubsub = self._pubsub, None
        if pubsub is not None:
            try:
                async with asyncio.timeout(5):
                    await pubsub.aclose()
            except (RedisError, OSError, TimeoutError) as error:
                control_log("auth.subscription_close_failed", level="WARNING", workerId=self.worker_id,
                            **error_fields(error))

    async def get(self, connector_id: str) -> str:
        await self.start()
        while True:
            if self._closed or not self.healthy:
                raise RedisError("credential invalidation subscription unavailable")
            entry = self._entries.get(connector_id)
            if entry is not None and entry.value is not None and self.clock() < entry.expires_at:
                self._entries.move_to_end(connector_id)
                return entry.value
            entry = self._inflight.get(connector_id)
            if entry is None:
                entry = _Entry()
                self._inflight[connector_id] = entry
                entry.task = asyncio.create_task(self._load(connector_id, entry), name="mesh-credential-load")
                self._loads.add(entry.task)
                entry.task.add_done_callback(self._loaded)
            task = entry.task
            entry.waiters += 1
            try:
                value = await asyncio.shield(task)
                if not entry.invalidated and not self._closed and self.healthy:
                    return value
            finally:
                entry.waiters -= 1
                if not entry.waiters and task.done():
                    self._release_load(connector_id, entry)

    def _release_load(self, connector_id: str, entry: _Entry) -> None:
        if self._inflight.get(connector_id) is entry:
            self._inflight.pop(connector_id)
        entry.task = None

    def _loaded(self, task: asyncio.Task) -> None:
        self._loads.discard(task)
        if not task.cancelled():
            task.exception()  # Consume errors even when the only caller disconnected.

    async def _load(self, connector_id: str, entry: _Entry) -> str:
        started = self.clock()
        try:
            async with asyncio.timeout(5):
                value = await self.load(connector_id)
            entry.value, entry.expires_at = value, started + self.ttl
            if not entry.invalidated and not self._closed and self.healthy:
                self._entries[connector_id] = entry
                self._entries.move_to_end(connector_id)
                while len(self._entries) > self.capacity:
                    self._entries.popitem(last=False)
            control_log("auth.cache_loaded", level="DEBUG", connectorId=connector_id, workerId=self.worker_id,
                        elapsedMs=(self.clock() - started) * 1000)
            return value
        except BaseException as error:
            if self._inflight.get(connector_id) is entry:
                self._inflight.pop(connector_id)
            entry.invalidated = True
            if isinstance(error, Exception):
                control_log("auth.cache_load_failed", level="WARNING", connectorId=connector_id,
                            workerId=self.worker_id, **error_fields(error))
            raise
        finally:
            # A completed load remains revocable until its last waiter has
            # consumed it, even if LRU pressure already evicted its value.
            if not entry.waiters:
                self._release_load(connector_id, entry)

    async def close(self) -> None:
        self._closed = True
        self.healthy = False
        if self._closing is None:
            self._closing = asyncio.create_task(self._close(), name="connector-credential-close")
        await complete_cleanup(self._closing)

    async def _close(self) -> None:
        async with self._start_lock:
            self.invalidate_local()
            tasks = [*self._loads, *([self._listener] if self._listener is not None else [])]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self._listener = None
            await self._close_subscription()
