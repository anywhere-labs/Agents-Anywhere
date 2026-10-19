"""Thread-safe ordered event fan-out with replay.

MeshCall v0.3 has no subscriptions of its own, so the Connector keeps a small
ring of recent events per stream and hands each subscriber a bounded queue.
Producers may run on any thread (loguru sinks do); consumers are MeshCall
stream handlers on the service worker loop and read with a short blocking wait.
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import threading
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass

# How long a consumer blocks before checking for cancellation or closure.
_POLL_SECONDS = 0.5


@dataclass(frozen=True)
class Sequenced[T]:
    """One published item; ``seq`` grows by one per item of the hub."""

    seq: int
    kind: str
    item: T


class Subscription[T]:
    """One consumer's bounded view; the oldest item is dropped to keep it live."""

    def __init__(self, hub: EventHub[T], replay: Iterable[Sequenced[T]], capacity: int) -> None:
        self._hub = hub
        self._capacity = capacity
        self._condition = threading.Condition()
        self._items: collections.deque[Sequenced[T]] = collections.deque(replay)
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    def push(self, event: Sequenced[T]) -> None:
        with self._condition:
            if event.kind in self._hub.coalescing:
                # Only the newest state matters; a stale one must not follow it.
                self._items = collections.deque(item for item in self._items if item.kind != event.kind)
            elif len(self._items) >= self._capacity:
                self._items.popleft()
            self._items.append(event)
            self._condition.notify()

    def next(self, timeout: float = _POLL_SECONDS) -> Sequenced[T] | None:
        with self._condition:
            if not self._items and not self._closed:
                self._condition.wait(timeout)
            if not self._items:
                return None
            return self._items.popleft()

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._condition.notify_all()
        self._hub.unsubscribe(self)


class EventHub[T]:
    """A ring of recent events plus live subscribers, safe to publish from any thread."""

    def __init__(self, *, history: int, capacity: int, coalescing: frozenset[str] = frozenset()) -> None:
        self.history = history
        self.capacity = capacity
        self.coalescing = coalescing
        self._lock = threading.Lock()
        self._seq = 0
        self._ring: collections.deque[Sequenced[T]] = collections.deque(maxlen=history)
        self._subscribers: set[Subscription[T]] = set()

    def publish(self, kind: str, item: T) -> None:
        with self._lock:
            self._seq += 1
            event = Sequenced(self._seq, kind, item)
            self._ring.append(event)
            for subscription in tuple(self._subscribers):
                subscription.push(event)

    def subscribe(self, since: int | None = None) -> Subscription[T]:
        """Replay events after ``since`` (or the whole ring for a fresh stream)."""
        with self._lock:
            replay = list(self._ring) if since is None else [event for event in self._ring if event.seq > since]
            subscription = Subscription(self, replay, self.capacity)
            self._subscribers.add(subscription)
            return subscription

    def unsubscribe(self, subscription: Subscription[T]) -> None:
        with self._lock:
            self._subscribers.discard(subscription)

    @property
    def last_seq(self) -> int:
        return self._seq


async def stream_items[T](subscription: Subscription[T]) -> AsyncIterator[Sequenced[T]]:
    """Adapt a thread-safe subscription to a stream handler (cancellation closes it)."""
    try:
        while not subscription.closed:
            event = await asyncio.to_thread(subscription.next)
            if event is not None:
                yield event
    finally:
        with contextlib.suppress(Exception):
            subscription.close()
