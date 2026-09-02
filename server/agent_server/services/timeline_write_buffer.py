from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

from loguru import logger
from redis.exceptions import WatchError

from agent_server.core.models import SessionView, TimelineItem, TimelineItemIn
from agent_server.core.timeline import (
    TimelineBatchWriteResult,
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
from agent_server.services.session_revision_allocator import (
    DEFAULT_REVISION_LEASE_SIZE,
    SessionRevisionAllocator,
    SessionRevisionRepairNeeded,
)

DEFAULT_FLUSH_INTERVAL_SECONDS = 1.0
DEFAULT_LANE_CACHE_ITEMS = 1024


@dataclass(slots=True)
class _PendingSnapshot:
    items: dict[str, TimelineItem]
    raw_items: dict[str, str]
    source_observed_at: str | None
    raw_source_observed_at: str | None
    mark_read_on_change: bool
    raw_mark_read_on_change: str | None


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
        revision_lease_size: int = DEFAULT_REVISION_LEASE_SIZE,
    ) -> None:
        if flush_interval_seconds <= 0:
            raise ValueError("timeline flush interval must be positive")
        self._store = store
        self._broker = broker
        self._coordinator = coordinator
        self._flush_interval_seconds = flush_interval_seconds
        self._sequences = SessionRevisionAllocator(
            store,
            coordinator,
            lease_size=revision_lease_size,
        )
        self._lanes: dict[str, _SessionLane] = {}
        self._lanes_guard = _CrossLoopLock()
        self._local_pending: dict[str, dict[str, str]] = {}
        self._local_sources: dict[str, str] = {}
        self._local_mark_read: set[str] = set()
        self._local_dirty: set[str] = set()
        self._active_session_fences: ContextVar[frozenset[str]] = ContextVar(
            f"timeline-write-buffer-fences-{id(self)}",
            default=frozenset(),
        )
        self._sweeper_task: asyncio.Task[None] | None = None
        self._closing = False
        self._closed = False
        bind_fence = getattr(store, "bind_session_revision_fence", None)
        if bind_fence is not None:
            bind_fence(self.session_fence)
        bind_publisher = getattr(store, "bind_session_revision_publisher", None)
        if bind_publisher is not None:
            bind_publisher(self.publish_revision_result)
        bind_sealer = getattr(store, "bind_session_revision_range_sealer", None)
        if bind_sealer is not None:
            bind_sealer(self._sequences.seal_active_range)

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
        async with lane.lock, self._sequences.session_fence(session_id):
            server_epoch, epoch_changed = await self._sequences.observe_server_epoch(
                session_id
            )
            if epoch_changed:
                lane.latest.clear()
                lane.max_order_seq = None
                lane.seeded = False
            await self._repair_unpublished_locked(session_id)
            lane_was_seeded = lane.seeded
            await self._seed_lane(session_id, lane)
            existing = lane.latest.get(item.id)
            durable_item_checked = False
            if self._coordinator.distributed:
                shared_existing = await self._pending_item(session_id, item.id)
                if shared_existing is not None:
                    if (
                        existing is None
                        or shared_existing.updatedSeq >= existing.updatedSeq
                    ):
                        existing = shared_existing
                        self._remember(lane, shared_existing)
                else:
                    existing = await self._store.timeline.read_one(session_id, item.id)
                    durable_item_checked = True
                    if existing is None:
                        lane.latest.pop(item.id, None)
                    else:
                        self._remember(lane, existing)
                        lane.max_order_seq = max(
                            lane.max_order_seq or 0,
                            existing.orderSeq,
                        )
            if existing is None and self._coordinator.distributed and lane_was_seeded:
                # Another Server may have accepted a different new item since
                # this process last used the lane. Refresh the shared order head
                # only for that cross-instance cache case; the initial seed has
                # already read the same projection and durable max.
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
            if existing is None and not durable_item_checked:
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

            while True:
                try:
                    updated_seq = await self._sequences.reserve_timeline_revision(
                        session_id=session_id,
                        mark_read_on_change=mark_read_on_change,
                        server_epoch=server_epoch,
                    )
                    break
                except SessionRevisionRepairNeeded:
                    await self._repair_unpublished_locked(session_id)
            if (
                self._coordinator.distributed
                and await self._coordinator.server_epoch() != server_epoch
            ):
                raise RuntimeError(
                    "Redis server epoch changed during session revision allocation"
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
                mark_read_on_change=mark_read_on_change,
            )
            self._remember(lane, normalized)
            lane.max_order_seq = max(max_order_seq, normalized.orderSeq)
            await self._broker.publish(
                session_id,
                {
                    "sessionId": session_id,
                    "nextSeq": normalized.updatedSeq,
                    "items": [normalized.model_dump(mode="json")],
                },
            )
            await self._sequences.mark_published(session_id, normalized.updatedSeq)
            return TimelineItemWriteResult(item=normalized, changed=True)

    async def flush_through(self, session_id: str) -> None:
        """Materialize the accepted pending view visible at this read barrier."""

        await self.flush_session(session_id)

    async def flush_session(self, session_id: str) -> None:
        lane = await self._lane(session_id)
        async with lane.lock, self._sequences.session_fence(session_id):
            await self._flush_locked(session_id)

    async def dirty_session_ids(self) -> list[str]:
        """Return a stable snapshot of sessions with pending buffer state."""

        return sorted(await self._dirty_sessions())

    @asynccontextmanager
    async def session_fence(self, session_id: str) -> AsyncIterator[None]:
        """Flush and exclude another accepted item for one stable operation."""

        active_fences = self._active_session_fences.get()
        if session_id in active_fences:
            yield
            return

        lane = await self._lane(session_id)
        async with lane.lock, self._sequences.session_fence(session_id):
            token = self._active_session_fences.set(active_fences | {session_id})
            try:
                try:
                    durable_before = await self._store.get_session_seq(session_id)
                except KeyError:
                    durable_before = None
                if durable_before is not None:
                    await self._sequences.initialize_published_head(
                        session_id,
                        durable_before,
                    )
                await self._flush_locked(session_id)
                yield
            finally:
                try:
                    try:
                        durable_sequence = await self._store.get_session_seq(session_id)
                    except KeyError:
                        durable_sequence = None
                    if durable_sequence is not None:
                        await self._sequences.floor(session_id, durable_sequence)
                        published_through = (
                            await self._sequences.published_head(session_id) or 0
                        )
                        if durable_sequence > published_through:
                            session = await self._store.get_session(session_id)
                            await self._broker.publish(
                                session_id,
                                {
                                    "sessionId": session_id,
                                    "nextSeq": durable_sequence,
                                    "session": session.model_dump(mode="json"),
                                    "refetch": True,
                                },
                            )
                            await self._sequences.mark_published(
                                session_id,
                                durable_sequence,
                            )
                finally:
                    self._active_session_fences.reset(token)

    async def publish_revision_result(
        self,
        session_id: str,
        *,
        operation: str,
        result: object,
    ) -> None:
        """Publish a durable low-frequency writer before releasing its fence."""

        durable_sequence = await self._store.get_session_seq(session_id)
        published_through = await self._sequences.published_head(session_id)
        if (
            isinstance(result, TimelineBatchWriteResult)
            and not result.changed
            and published_through is not None
            and published_through >= durable_sequence
        ):
            return
        session = (
            result
            if isinstance(result, SessionView)
            else await self._store.get_session(session_id)
        )
        envelope: dict[str, Any] = {
            "sessionId": session_id,
            "nextSeq": durable_sequence,
        }
        if isinstance(result, SessionView):
            envelope["session"] = session.model_dump(mode="json")
        elif isinstance(result, TimelineItemWriteResult):
            envelope["items"] = [result.item.model_dump(mode="json")]
        elif isinstance(result, TimelineBatchWriteResult):
            result_items = list(result.items)
            if not result_items and published_through != durable_sequence:
                result_items = await self._store.timeline.read(session_id)
                envelope["timelineReset"] = True
            if len(result_items) > 100:
                envelope.pop("timelineReset", None)
                envelope["refetch"] = True
            else:
                envelope["items"] = [
                    item.model_dump(mode="json") for item in result_items
                ]
            if operation == "replace_timeline_snapshot" and "items" in envelope:
                envelope["timelineReset"] = True
        else:
            envelope["session"] = session.model_dump(mode="json")
        await self._broker.publish(session_id, envelope)
        await self._sequences.mark_published(session_id, durable_sequence)

    async def live_sequence(self, session_id: str) -> int:
        """Return the highest live or durable revision for an envelope."""

        return await self._sequences.live_head(session_id)

    async def _flush_locked(self, session_id: str) -> None:
        snapshot = await self._pending_snapshot(session_id)
        if (
            not snapshot.items
            and snapshot.source_observed_at is None
            and not snapshot.mark_read_on_change
        ):
            await self._clear_snapshot(session_id, snapshot)
            return
        result = await self._store.persist_buffered_timeline_items(
            session_id=session_id,
            items=list(snapshot.items.values()),
            source_observed_at=snapshot.source_observed_at,
            mark_read_on_change=snapshot.mark_read_on_change,
        )
        if result.items:
            next_seq = await self._store.get_session_seq(session_id)
            published_through = await self._sequences.published_head(session_id)
            if published_through is None or published_through < next_seq:
                await self._broker.publish(
                    session_id,
                    {
                        "sessionId": session_id,
                        "nextSeq": next_seq,
                        "items": [
                            item.model_dump(mode="json") for item in result.items
                        ],
                    },
                )
                await self._sequences.mark_published(session_id, next_seq)
            await publish_dashboard_changed(
                self._store,
                self._broker,
                session_id=session_id,
                reason="timeline.persisted",
            )
        await self._clear_snapshot(session_id, snapshot)

    async def _repair_unpublished_locked(self, session_id: str) -> None:
        """Close a failed publication before a higher revision is allocated."""

        if not await self._sequences.has_unpublished_live_revision(session_id):
            return
        # The common failure mode has a staged item whose direct broker publish
        # failed. Materialize and republish it before accepting another item.
        await self._flush_locked(session_id)
        if not await self._sequences.has_unpublished_live_revision(session_id):
            return

        # Reserving a revision can succeed before pending storage fails. Such
        # an empty sequence is legal, but publish an explicit recovery boundary
        # so the next higher event cannot silently jump over it.
        live_sequence = await self._sequences.live_head(session_id)
        session = await self._store.get_session(session_id)
        await self._broker.publish(
            session_id,
            {
                "sessionId": session_id,
                "nextSeq": live_sequence,
                "session": session.model_dump(mode="json"),
                "refetch": True,
            },
        )
        await self._sequences.mark_published(session_id, live_sequence)

    async def flush_all(self, *, suppress_errors: bool = False) -> None:
        session_ids = await self._dirty_sessions()
        first_error: Exception | None = None
        for session_id in sorted(session_ids):
            try:
                await self.flush_session(session_id)
            except KeyError:
                lane = await self._lane(session_id)
                async with lane.lock, self._sequences.session_fence(session_id):
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
        mark_read_on_change: bool = False,
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
            async with self._coordinator.pipeline_while_lock_owned(
                f"session-revision:{session_id}"
            ) as pipeline:
                if source_observed_at is not None:
                    pipeline.set(
                        self._source_key(session_id),
                        source_observed_at,
                    )
                if item is not None and raw_item is not None:
                    pipeline.hset(self._items_key(session_id), item.id, raw_item)
                if mark_read_on_change:
                    pipeline.set(self._mark_read_key(session_id), "1")
                pipeline.sadd(self._dirty_key(), session_id)
            return
        if source_observed_at is not None:
            self._local_sources[session_id] = source_observed_at
        if item is not None and raw_item is not None:
            self._local_pending.setdefault(session_id, {})[item.id] = raw_item
        if mark_read_on_change:
            self._local_mark_read.add(session_id)
        self._local_dirty.add(session_id)

    async def _pending_snapshot(self, session_id: str) -> _PendingSnapshot:
        if self._coordinator.distributed:
            (
                raw_items_value,
                raw_source_value,
                raw_mark_read_value,
            ) = await asyncio.gather(
                self._coordinator.client.hgetall(self._items_key(session_id)),
                self._coordinator.client.get(self._source_key(session_id)),
                self._coordinator.client.get(self._mark_read_key(session_id)),
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
            raw_mark_read = (
                self._as_text(raw_mark_read_value)
                if raw_mark_read_value is not None
                else None
            )
        else:
            raw_items = dict(self._local_pending.get(session_id, {}))
            raw_source = self._local_sources.get(session_id)
            raw_mark_read = "1" if session_id in self._local_mark_read else None
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
            mark_read_on_change=raw_mark_read == "1",
            raw_mark_read_on_change=raw_mark_read,
        )

    async def _pending_item(
        self,
        session_id: str,
        item_id: str,
    ) -> TimelineItem | None:
        if not self._coordinator.distributed:
            raw_item = self._local_pending.get(session_id, {}).get(item_id)
        else:
            raw_value = await self._coordinator.client.hget(
                self._items_key(session_id),
                item_id,
            )
            raw_item = self._as_text(raw_value) if raw_value is not None else None
        if raw_item is None:
            return None
        try:
            return TimelineItem.model_validate_json(raw_item)
        except ValueError as exc:
            raise RuntimeError(
                "invalid pending timeline item "
                f"session_id={session_id} item_id={item_id}"
            ) from exc

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
            snapshot.raw_mark_read_on_change is not None
            and session_id in self._local_mark_read
        ):
            self._local_mark_read.discard(session_id)
        if (
            session_id not in self._local_pending
            and session_id not in self._local_sources
            and session_id not in self._local_mark_read
        ):
            self._local_dirty.discard(session_id)

    async def _clear_distributed_snapshot(
        self,
        session_id: str,
        snapshot: _PendingSnapshot,
    ) -> None:
        items_key = self._items_key(session_id)
        source_key = self._source_key(session_id)
        mark_read_key = self._mark_read_key(session_id)
        dirty_key = self._dirty_key()
        lock_name = f"session-revision:{session_id}"
        lock_key, lock_token = self._coordinator.lock_fence(lock_name)
        while True:
            async with self._coordinator.client.pipeline(transaction=True) as pipeline:
                try:
                    await pipeline.watch(
                        lock_key,
                        items_key,
                        source_key,
                        mark_read_key,
                    )
                    current_lock_token = await pipeline.get(lock_key)
                    if isinstance(current_lock_token, bytes):
                        current_lock_token = current_lock_token.decode("utf-8")
                    if current_lock_token != lock_token:
                        raise RuntimeError(
                            f"distributed lock is no longer owned: {lock_key}"
                        )
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
                    raw_current_mark_read = await pipeline.get(mark_read_key)
                    current_mark_read = (
                        self._as_text(raw_current_mark_read)
                        if raw_current_mark_read is not None
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
                    mark_read_is_removable = (
                        snapshot.raw_mark_read_on_change is not None
                        and current_mark_read == snapshot.raw_mark_read_on_change
                    )
                    remaining_item_ids = set(current_items) - set(removable_item_ids)
                    source_will_remain = (
                        current_source is not None and not source_is_removable
                    )
                    mark_read_will_remain = (
                        current_mark_read is not None and not mark_read_is_removable
                    )

                    pipeline.multi()
                    if removable_item_ids:
                        pipeline.hdel(items_key, *removable_item_ids)
                    if source_is_removable:
                        pipeline.delete(source_key)
                    if mark_read_is_removable:
                        pipeline.delete(mark_read_key)
                    if not remaining_item_ids:
                        pipeline.delete(items_key)
                    if (
                        not remaining_item_ids
                        and not source_will_remain
                        and not mark_read_will_remain
                    ):
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

    def _items_key(self, session_id: str) -> str:
        return self._coordinator.key("timeline-buffer", session_id, "items")

    def _source_key(self, session_id: str) -> str:
        return self._coordinator.key("timeline-buffer", session_id, "source")

    def _mark_read_key(self, session_id: str) -> str:
        return self._coordinator.key("timeline-buffer", session_id, "mark-read")

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
