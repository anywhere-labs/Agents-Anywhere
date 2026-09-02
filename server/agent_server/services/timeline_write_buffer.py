from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from typing import Any

from loguru import logger
from redis.exceptions import WatchError

from agent_server.core.models import TimelineItem, TimelineItemIn
from agent_server.core.timeline import (
    TimelineItemWriteResult,
    next_timeline_item_revision,
    timeline_item_from_runtime_input,
    timeline_item_state_is_unchanged,
)
from agent_server.core.utc import utc_now
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.repository_ports import TimelineBufferRepository

DEFAULT_FLUSH_INTERVAL_SECONDS = 1.0
DEFAULT_PENDING_TTL_SECONDS = 24 * 60 * 60
DEFAULT_LANE_CACHE_ITEMS = 1024


@dataclass(slots=True)
class _PendingSnapshot:
    items: dict[str, TimelineItem]
    raw_items: dict[str, str]
    source_observed_at: str | None
    raw_source_observed_at: str | None


@dataclass(slots=True)
class _SessionLane:
    lock: _CrossLoopLock = field(default_factory=lambda: _CrossLoopLock())
    latest: dict[str, TimelineItem] = field(default_factory=dict)
    max_order_seq: int | None = None
    seeded: bool = False


class _CrossLoopLock:
    """Small async mutex that also works across TestClient event-loop threads."""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._locked = False

    async def __aenter__(self) -> None:
        while True:
            with self._guard:
                if not self._locked:
                    self._locked = True
                    return
            await asyncio.sleep(0.001)

    async def __aexit__(
        self,
        _exc_type: object,
        _exc: object,
        _traceback: object,
    ) -> None:
        with self._guard:
            self._locked = False


class TimelineWriteBuffer:
    """Coalesce high-frequency timeline projections while preserving live order.

    A changed item first reserves its public session sequence.  The complete
    pre-sequenced item is then stored in the shared pending projection and can
    be pushed immediately.  The worker materializes only the latest value for
    each stable item ID into the timeline table.

    Redis is the shared pending projection in distributed deployments.  The
    in-memory backend is intentionally limited to a single server process.
    """

    def __init__(
        self,
        store: TimelineBufferRepository,
        broker: TimelineBroker,
        coordinator: RedisCoordinator,
        *,
        flush_interval_seconds: float = DEFAULT_FLUSH_INTERVAL_SECONDS,
        pending_ttl_seconds: int = DEFAULT_PENDING_TTL_SECONDS,
    ) -> None:
        if flush_interval_seconds <= 0:
            raise ValueError("timeline flush interval must be positive")
        if pending_ttl_seconds <= 0:
            raise ValueError("timeline pending TTL must be positive")
        self._store = store
        self._broker = broker
        self._coordinator = coordinator
        self._flush_interval_seconds = flush_interval_seconds
        self._pending_ttl_seconds = pending_ttl_seconds
        self._lanes: dict[str, _SessionLane] = {}
        self._lanes_guard = _CrossLoopLock()
        self._local_pending: dict[str, dict[str, str]] = {}
        self._local_sources: dict[str, str] = {}
        self._local_dirty: set[str] = set()
        self._sweeper_task: asyncio.Task[None] | None = None
        self._closing = False
        self._closed = False

    async def start(self) -> None:
        if self._closed:
            raise RuntimeError("timeline write buffer is closed")
        if self._sweeper_task is not None:
            return
        self._sweeper_task = asyncio.create_task(
            self._run_sweeper(),
            name="timeline-write-buffer",
        )

    async def close(self) -> None:
        if self._closed:
            return
        self._closing = True
        task = self._sweeper_task
        self._sweeper_task = None
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        await self.flush_all()
        self._closed = True

    async def accept(
        self,
        *,
        session_id: str,
        item: TimelineItemIn,
        source_observed_at: str | None = None,
        mark_read_on_change: bool = False,
    ) -> TimelineItemWriteResult:
        if self._closing or self._closed:
            raise RuntimeError("timeline write buffer is closing")
        lane = await self._lane(session_id)
        async with lane.lock, self._distributed_session_lock(session_id):
            await self._seed_lane(session_id, lane)
            existing = lane.latest.get(item.id)
            if existing is None:
                shared_snapshot = await self._pending_snapshot(session_id)
                lane.latest.update(shared_snapshot.items)
                self._trim_lane_cache(lane)
                lane.max_order_seq = max(
                    [
                        lane.max_order_seq or 0,
                        await self._store.get_max_timeline_order_seq(session_id),
                    ]
                    + [
                        pending_item.orderSeq
                        for pending_item in shared_snapshot.items.values()
                    ]
                )
                existing = lane.latest.get(item.id)
            if existing is None:
                existing = await self._store.timeline.read_one(session_id, item.id)
                if existing is not None:
                    self._remember(lane, existing)
                    lane.max_order_seq = max(
                        lane.max_order_seq or 0,
                        existing.orderSeq,
                    )

            unchanged = existing is not None and timeline_item_state_is_unchanged(
                existing, item
            )
            if unchanged:
                if source_observed_at is not None:
                    await self._store_pending(
                        session_id,
                        source_observed_at=source_observed_at,
                    )
                return TimelineItemWriteResult(item=existing, changed=False)

            updated_seq = await self._store.reserve_timeline_sequence(
                session_id=session_id,
                mark_read_on_change=mark_read_on_change,
            )
            max_order_seq = lane.max_order_seq or 0
            if existing is not None:
                order_seq = existing.orderSeq
            elif item.orderSeq > max_order_seq:
                order_seq = item.orderSeq
            else:
                order_seq = max_order_seq + 1
            normalized = timeline_item_from_runtime_input(
                item,
                updated_seq=updated_seq,
                now=utc_now(),
                existing=existing,
                order_seq=order_seq,
                revision=next_timeline_item_revision(item, existing),
            )
            await self._store_pending(
                session_id,
                item=normalized,
                source_observed_at=source_observed_at,
            )
            self._remember(lane, normalized)
            lane.max_order_seq = max(max_order_seq, normalized.orderSeq)
            return TimelineItemWriteResult(item=normalized, changed=True)

    async def flush_through(self, session_id: str) -> None:
        """Materialize the accepted pending view visible at this read barrier."""

        await self.flush_session(session_id)

    async def flush_session(self, session_id: str) -> None:
        lane = await self._lane(session_id)
        async with lane.lock, self._distributed_session_lock(session_id):
            await self._flush_locked(session_id)

    @asynccontextmanager
    async def session_fence(self, session_id: str) -> AsyncIterator[None]:
        """Flush and exclude another accepted item for one stable operation."""

        lane = await self._lane(session_id)
        async with lane.lock, self._distributed_session_lock(session_id):
            await self._flush_locked(session_id)
            yield

    async def _flush_locked(self, session_id: str) -> None:
        snapshot = await self._pending_snapshot(session_id)
        if not snapshot.items and snapshot.source_observed_at is None:
            await self._clear_snapshot(session_id, snapshot)
            return
        result = await self._store.persist_buffered_timeline_items(
            session_id=session_id,
            items=list(snapshot.items.values()),
            source_observed_at=snapshot.source_observed_at,
        )
        if result.items:
            next_seq = await self._store.get_session_seq(session_id)
            await self._broker.publish(
                session_id,
                {
                    "sessionId": session_id,
                    "nextSeq": next_seq,
                    "items": [item.model_dump(mode="json") for item in result.items],
                },
            )
            await publish_dashboard_changed(
                self._store,
                self._broker,
                session_id=session_id,
                reason="timeline.persisted",
            )
        await self._clear_snapshot(session_id, snapshot)

    async def flush_all(self, *, suppress_errors: bool = False) -> None:
        session_ids = await self._dirty_sessions()
        first_error: Exception | None = None
        for session_id in sorted(session_ids):
            try:
                await self.flush_session(session_id)
            except KeyError:
                snapshot = await self._pending_snapshot(session_id)
                await self._clear_snapshot(session_id, snapshot)
            except Exception as exc:  # noqa: BLE001 - drain every independent lane
                logger.exception(
                    "timeline buffer flush failed session_id={}",
                    session_id,
                )
                if first_error is None:
                    first_error = exc
        if first_error is not None and not suppress_errors:
            raise first_error

    async def invalidate(self, session_id: str) -> None:
        """Drop normalization cache after a synchronous timeline mutation."""

        lane = await self._lane(session_id)
        async with lane.lock:
            lane.latest.clear()
            lane.max_order_seq = None
            lane.seeded = False

    async def _run_sweeper(self) -> None:
        while True:
            await asyncio.sleep(self._flush_interval_seconds)
            try:
                await self.flush_all(suppress_errors=True)
            except Exception:  # noqa: BLE001 - retry coordinator failures
                logger.exception("timeline buffer sweep failed")

    async def _lane(self, session_id: str) -> _SessionLane:
        async with self._lanes_guard:
            lane = self._lanes.get(session_id)
            if lane is None:
                lane = _SessionLane()
                self._lanes[session_id] = lane
            return lane

    async def _seed_lane(self, session_id: str, lane: _SessionLane) -> None:
        if lane.seeded:
            return
        snapshot = await self._pending_snapshot(session_id)
        lane.latest.update(snapshot.items)
        self._trim_lane_cache(lane)
        durable_max_order_seq = await self._store.get_max_timeline_order_seq(session_id)
        lane.max_order_seq = max(
            [durable_max_order_seq]
            + [item.orderSeq for item in snapshot.items.values()]
        )
        lane.seeded = True

    async def _store_pending(
        self,
        session_id: str,
        *,
        item: TimelineItem | None = None,
        source_observed_at: str | None = None,
    ) -> None:
        raw_item = (
            json.dumps(
                item.model_dump(mode="json"),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            )
            if item is not None
            else None
        )
        if self._coordinator.distributed:
            async with self._coordinator.client.pipeline(transaction=True) as pipeline:
                if source_observed_at is not None:
                    pipeline.set(
                        self._source_key(session_id),
                        source_observed_at,
                        ex=self._pending_ttl_seconds,
                    )
                if item is not None and raw_item is not None:
                    pipeline.hset(self._items_key(session_id), item.id, raw_item)
                    pipeline.expire(
                        self._items_key(session_id),
                        self._pending_ttl_seconds,
                    )
                pipeline.sadd(self._dirty_key(), session_id)
                await pipeline.execute()
            return
        if source_observed_at is not None:
            self._local_sources[session_id] = source_observed_at
        if item is not None and raw_item is not None:
            self._local_pending.setdefault(session_id, {})[item.id] = raw_item
        self._local_dirty.add(session_id)

    async def _pending_snapshot(self, session_id: str) -> _PendingSnapshot:
        if self._coordinator.distributed:
            raw_items_value, raw_source_value = await asyncio.gather(
                self._coordinator.client.hgetall(self._items_key(session_id)),
                self._coordinator.client.get(self._source_key(session_id)),
            )
            raw_items = {
                self._as_text(item_id): self._as_text(value)
                for item_id, value in raw_items_value.items()
            }
            raw_source = (
                self._as_text(raw_source_value)
                if raw_source_value is not None
                else None
            )
        else:
            raw_items = dict(self._local_pending.get(session_id, {}))
            raw_source = self._local_sources.get(session_id)
        items: dict[str, TimelineItem] = {}
        for item_id, raw_item in raw_items.items():
            try:
                item = TimelineItem.model_validate_json(raw_item)
            except ValueError as exc:
                raise RuntimeError(
                    "invalid pending timeline item "
                    f"session_id={session_id} item_id={item_id}"
                ) from exc
            items[item_id] = item
        return _PendingSnapshot(
            items=items,
            raw_items=raw_items,
            source_observed_at=raw_source,
            raw_source_observed_at=raw_source,
        )

    async def _clear_snapshot(
        self,
        session_id: str,
        snapshot: _PendingSnapshot,
    ) -> None:
        if self._coordinator.distributed:
            await self._clear_distributed_snapshot(session_id, snapshot)
            return
        current_items = self._local_pending.get(session_id)
        if current_items is not None:
            for item_id, raw_item in snapshot.raw_items.items():
                if current_items.get(item_id) == raw_item:
                    current_items.pop(item_id, None)
            if not current_items:
                self._local_pending.pop(session_id, None)
        if (
            snapshot.raw_source_observed_at is not None
            and self._local_sources.get(session_id) == snapshot.raw_source_observed_at
        ):
            self._local_sources.pop(session_id, None)
        if (
            session_id not in self._local_pending
            and session_id not in self._local_sources
        ):
            self._local_dirty.discard(session_id)

    async def _clear_distributed_snapshot(
        self,
        session_id: str,
        snapshot: _PendingSnapshot,
    ) -> None:
        items_key = self._items_key(session_id)
        source_key = self._source_key(session_id)
        dirty_key = self._dirty_key()
        while True:
            async with self._coordinator.client.pipeline(transaction=True) as pipeline:
                try:
                    await pipeline.watch(items_key, source_key)
                    raw_current_items = await pipeline.hgetall(items_key)
                    current_items = {
                        self._as_text(item_id): self._as_text(value)
                        for item_id, value in raw_current_items.items()
                    }
                    raw_current_source = await pipeline.get(source_key)
                    current_source = (
                        self._as_text(raw_current_source)
                        if raw_current_source is not None
                        else None
                    )
                    removable_item_ids = [
                        item_id
                        for item_id, raw_item in snapshot.raw_items.items()
                        if current_items.get(item_id) == raw_item
                    ]
                    source_is_removable = (
                        snapshot.raw_source_observed_at is not None
                        and current_source == snapshot.raw_source_observed_at
                    )
                    remaining_item_ids = set(current_items) - set(removable_item_ids)
                    source_will_remain = (
                        current_source is not None and not source_is_removable
                    )

                    pipeline.multi()
                    if removable_item_ids:
                        pipeline.hdel(items_key, *removable_item_ids)
                    if source_is_removable:
                        pipeline.delete(source_key)
                    if not remaining_item_ids:
                        pipeline.delete(items_key)
                    if not remaining_item_ids and not source_will_remain:
                        pipeline.srem(dirty_key, session_id)
                    await pipeline.execute()
                    return
                except WatchError:
                    continue

    async def _dirty_sessions(self) -> set[str]:
        if self._coordinator.distributed:
            values = await self._coordinator.client.smembers(self._dirty_key())
            return {self._as_text(value) for value in values}
        return set(self._local_dirty)

    @asynccontextmanager
    async def _distributed_session_lock(
        self,
        session_id: str,
    ) -> AsyncIterator[None]:
        if not self._coordinator.distributed:
            yield
            return
        async with self._coordinator.lock(
            f"timeline-buffer:{session_id}",
            timeout_seconds=30,
        ):
            yield

    def _items_key(self, session_id: str) -> str:
        return self._coordinator.key("timeline-buffer", session_id, "items")

    def _source_key(self, session_id: str) -> str:
        return self._coordinator.key("timeline-buffer", session_id, "source")

    def _dirty_key(self) -> str:
        return self._coordinator.key("timeline-buffer", "dirty")

    @staticmethod
    def _remember(lane: _SessionLane, item: TimelineItem) -> None:
        lane.latest.pop(item.id, None)
        lane.latest[item.id] = item
        TimelineWriteBuffer._trim_lane_cache(lane)

    @staticmethod
    def _trim_lane_cache(lane: _SessionLane) -> None:
        while len(lane.latest) > DEFAULT_LANE_CACHE_ITEMS:
            lane.latest.pop(next(iter(lane.latest)))

    @staticmethod
    def _as_text(value: Any) -> str:
        if isinstance(value, bytes):
            return value.decode("utf-8")
        return str(value)
