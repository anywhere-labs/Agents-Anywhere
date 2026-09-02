"""Fan timeline changes out to local session subscribers.

Lives alongside `TerminalBroker`. The connector ingress publishes a small
envelope here when a timeline item is accepted, then may publish the same
pre-sequenced item again after its coalesced database projection commits.
Clients use the item sequence and deterministic event ID to make that durable
echo idempotent. Dashboard invalidation remains commit-driven.

When Redis is configured, Pub/Sub relays these invalidation messages between
server instances. Messages remain deliberately ephemeral; the shared pending
projection and explicit read barriers provide the durable recovery boundary.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import suppress

from agent_server.infra.redis_coordinator import RedisCoordinator


class TimelineBroker:
    def __init__(
        self,
        coordinator: RedisCoordinator | None = None,
        *,
        dashboard_debounce_seconds: float = 0.0,
    ) -> None:
        self._coordinator = coordinator or RedisCoordinator()
        self._subs: dict[str, set[asyncio.Queue[str]]] = {}
        self._dashboard_subs: dict[str, set[asyncio.Queue[str]]] = {}
        self._dashboard_pending: dict[str, dict] = {}
        self._dashboard_tasks: dict[str, asyncio.Task[None]] = {}
        self._dashboard_debounce_seconds = dashboard_debounce_seconds
        self._lock = asyncio.Lock()
        self._pubsub = None
        self._listener_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if not self._coordinator.distributed or self._listener_task is not None:
            return
        self._pubsub = self._coordinator.client.pubsub()
        await self._pubsub.psubscribe(
            self._coordinator.channel("timeline", "*"),
            self._coordinator.channel("dashboard", "*"),
        )
        self._listener_task = asyncio.create_task(
            self._listen(), name="redis-timeline-listener"
        )

    async def close(self) -> None:
        tasks = list(self._dashboard_tasks.values())
        if self._listener_task is not None:
            self._listener_task.cancel()
            tasks.append(self._listener_task)
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task
        self._listener_task = None
        self._dashboard_tasks.clear()
        self._dashboard_pending.clear()
        if self._pubsub is not None:
            await self._pubsub.aclose()
            self._pubsub = None

    async def publish(self, session_id: str, payload: dict) -> None:
        message = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        if self._coordinator.distributed:
            await self._coordinator.client.publish(
                self._coordinator.channel("timeline", session_id),
                message,
            )
            return
        await self._fan_out(self._subs, session_id, message)

    async def register(self, session_id: str) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=256)
        async with self._lock:
            self._subs.setdefault(session_id, set()).add(queue)
        return queue

    async def unregister(self, session_id: str, queue: asyncio.Queue[str]) -> None:
        async with self._lock:
            pool = self._subs.get(session_id)
            if pool is not None:
                pool.discard(queue)
                if not pool:
                    self._subs.pop(session_id, None)

    def subscriber_count(self, session_id: str) -> int:
        return len(self._subs.get(session_id, ()))

    async def publish_dashboard(self, user_id: str, payload: dict) -> None:
        if self._dashboard_debounce_seconds <= 0:
            message = json.dumps(
                {
                    **payload,
                    "type": "dashboard.changed",
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
            if self._coordinator.distributed:
                await self._coordinator.client.publish(
                    self._coordinator.channel("dashboard", user_id),
                    message,
                )
                return
            await self._fan_out(self._dashboard_subs, user_id, message)
            return
        async with self._lock:
            self._dashboard_pending[user_id] = {
                **payload,
                "type": "dashboard.changed",
            }
            if user_id not in self._dashboard_tasks:
                self._dashboard_tasks[user_id] = asyncio.create_task(
                    self._flush_dashboard_later(user_id)
                )

    async def _flush_dashboard_later(self, user_id: str) -> None:
        await asyncio.sleep(self._dashboard_debounce_seconds)
        async with self._lock:
            payload = self._dashboard_pending.pop(user_id, None)
            self._dashboard_tasks.pop(user_id, None)
            queues = list(self._dashboard_subs.get(user_id, ()))
        if payload is None:
            return
        message = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        if self._coordinator.distributed:
            await self._coordinator.client.publish(
                self._coordinator.channel("dashboard", user_id),
                message,
            )
        else:
            self._fan_out_queues(queues, message)

    async def _listen(self) -> None:
        assert self._pubsub is not None
        timeline_prefix = self._coordinator.channel("timeline", "")
        dashboard_prefix = self._coordinator.channel("dashboard", "")
        async for event in self._pubsub.listen():
            if event.get("type") != "pmessage":
                continue
            channel = self._as_text(event.get("channel"))
            message = self._as_text(event.get("data"))
            if channel.startswith(timeline_prefix):
                await self._fan_out(
                    self._subs, channel[len(timeline_prefix) :], message
                )
            elif channel.startswith(dashboard_prefix):
                await self._fan_out(
                    self._dashboard_subs,
                    channel[len(dashboard_prefix) :],
                    message,
                )

    async def _fan_out(
        self,
        subscriptions: dict[str, set[asyncio.Queue[str]]],
        key: str,
        message: str,
    ) -> None:
        # Snapshot under the lock so slow subscribers cannot block publishers.
        async with self._lock:
            queues = list(subscriptions.get(key, ()))
        self._fan_out_queues(queues, message)

    @staticmethod
    def _fan_out_queues(queues: list[asyncio.Queue[str]], message: str) -> None:
        for queue in queues:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(message)
                except asyncio.QueueFull:
                    pass

    @staticmethod
    def _as_text(value: object) -> str:
        if isinstance(value, bytes):
            return value.decode("utf-8")
        return str(value)

    async def register_dashboard(self, user_id: str) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=256)
        async with self._lock:
            self._dashboard_subs.setdefault(user_id, set()).add(queue)
        return queue

    async def unregister_dashboard(
        self, user_id: str, queue: asyncio.Queue[str]
    ) -> None:
        async with self._lock:
            pool = self._dashboard_subs.get(user_id)
            if pool is not None:
                pool.discard(queue)
                if not pool:
                    self._dashboard_subs.pop(user_id, None)
