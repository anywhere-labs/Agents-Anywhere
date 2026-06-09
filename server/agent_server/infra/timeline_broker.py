"""In-process pub/sub fanning timeline changes to SSE subscribers.

Lives alongside `TerminalBroker`. The connector ingress publishes a small
envelope (`{"sessionId", "nextSeq"}`) here right after a DB commit succeeds;
SSE subscribers wake immediately and fetch the incremental state. This
replaces the dominant cost of the old polling loop (1.25s mean wait between
"DB committed" and "frontend visible").

Single uvicorn worker only. Cross-worker fan-out would need Redis.
"""

from __future__ import annotations

import asyncio
import json


class TimelineBroker:
    def __init__(self, *, dashboard_debounce_seconds: float = 1.0) -> None:
        self._subs: dict[str, set[asyncio.Queue[str]]] = {}
        self._dashboard_subs: dict[str, set[asyncio.Queue[str]]] = {}
        self._dashboard_pending: dict[str, dict] = {}
        self._dashboard_tasks: dict[str, asyncio.Task[None]] = {}
        self._dashboard_debounce_seconds = dashboard_debounce_seconds
        self._lock = asyncio.Lock()

    async def publish(self, session_id: str, payload: dict) -> None:
        message = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        # Snapshot the set under the lock; put_nowait runs outside the lock
        # so a slow subscriber's queue doesn't block the publisher.
        async with self._lock:
            queues = list(self._subs.get(session_id, ()))
        for queue in queues:
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # Drop oldest, push new. SSE clients re-fetch by seq cursor
                # on every event so a coalesced event still triggers a
                # full refresh.
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(message)
                except asyncio.QueueFull:
                    pass

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
        try:
            await asyncio.sleep(self._dashboard_debounce_seconds)
            async with self._lock:
                payload = self._dashboard_pending.pop(user_id, None)
                self._dashboard_tasks.pop(user_id, None)
                queues = list(self._dashboard_subs.get(user_id, ()))
            if payload is None:
                return
            message = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            self._fan_out_dashboard(queues, message)
        except asyncio.CancelledError:
            raise

    def _fan_out_dashboard(self, queues: list[asyncio.Queue[str]], message: str) -> None:
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

    async def register_dashboard(self, user_id: str) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=256)
        async with self._lock:
            self._dashboard_subs.setdefault(user_id, set()).add(queue)
        return queue

    async def unregister_dashboard(self, user_id: str, queue: asyncio.Queue[str]) -> None:
        async with self._lock:
            pool = self._dashboard_subs.get(user_id)
            if pool is not None:
                pool.discard(queue)
                if not pool:
                    self._dashboard_subs.pop(user_id, None)
