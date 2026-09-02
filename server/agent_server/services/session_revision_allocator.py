from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Protocol

from agent_server.core.protocol import PROTOCOL_MAX_REVISION
from agent_server.infra.redis_coordinator import RedisCoordinator

DEFAULT_REVISION_LEASE_SIZE = 4096


class SessionRevisionRepairNeeded(RuntimeError):
    """Signal that a newly initialized lease exposed an unpublished gap."""


class SessionRevisionLeaseRepository(Protocol):
    async def get_session_seq(self, session_id: str) -> int: ...

    async def reserve_timeline_sequence(
        self,
        *,
        session_id: str,
        mark_read_on_change: bool = False,
    ) -> int: ...

    async def lease_session_revision_range(
        self,
        *,
        session_id: str,
        count: int,
    ) -> tuple[int, int]: ...


class SessionRevisionAllocator:
    """Allocate live session revisions without updating PostgreSQL per event.

    PostgreSQL leases disjoint ranges so a Redis restart can abandon an
    unfinished range without ever reusing a revision already observed by a
    client. Redis is the low-latency head while a range is active; the normal
    timeline flush advances the durable session watermark.

    Callers must hold ``session_fence`` across allocation, staging, and live
    publication. The Redis counter alone guarantees unique numbers, not the
    order in which independently executing writers publish them.
    """

    def __init__(
        self,
        store: SessionRevisionLeaseRepository,
        coordinator: RedisCoordinator,
        *,
        lease_size: int = DEFAULT_REVISION_LEASE_SIZE,
    ) -> None:
        if lease_size <= 0:
            raise ValueError("session revision lease size must be positive")
        self._store = store
        self._coordinator = coordinator
        self._lease_size = lease_size
        self._observed_epochs: dict[str, str] = {}
        self._local_published: dict[str, int] = {}

    @property
    def distributed(self) -> bool:
        return self._coordinator.distributed

    @asynccontextmanager
    async def session_fence(self, session_id: str) -> AsyncIterator[None]:
        if not self.distributed:
            yield
            return
        async with self._coordinator.lock(
            f"session-revision:{session_id}",
            timeout_seconds=30,
            lease_seconds=300,
        ):
            yield

    async def reserve_timeline_revision(
        self,
        *,
        session_id: str,
        mark_read_on_change: bool = False,
        server_epoch: str | None = None,
    ) -> int:
        if not self.distributed:
            return await self._store.reserve_timeline_sequence(
                session_id=session_id,
                mark_read_on_change=mark_read_on_change,
            )
        return await self._reserve_from_redis(
            session_id,
            count=1,
            server_epoch=server_epoch,
        )

    async def observe_server_epoch(self, session_id: str) -> tuple[str | None, bool]:
        """Observe Redis restart/failover before trusting the lane cache."""

        if not self.distributed:
            return None, False
        server_epoch = await self._coordinator.server_epoch()
        previous_epoch = self._observed_epochs.get(session_id)
        self._observed_epochs[session_id] = server_epoch
        return server_epoch, (
            previous_epoch is not None and previous_epoch != server_epoch
        )

    async def published_head(self, session_id: str) -> int | None:
        if not self.distributed:
            return self._local_published.get(session_id)
        raw_value = await self._coordinator.client.get(self._published_key(session_id))
        return self._parse_counter(raw_value)

    async def initialize_published_head(self, session_id: str, sequence: int) -> int:
        """Initialize publication tracking without overwriting an older gap."""

        if not self.distributed:
            return self._local_published.setdefault(session_id, sequence)
        key = self._published_key(session_id)
        await self._coordinator.client.set(key, sequence, nx=True)
        return self._parse_counter(await self._coordinator.client.get(key)) or 0

    async def mark_published(self, session_id: str, sequence: int) -> None:
        if not self.distributed:
            self._local_published[session_id] = max(
                self._local_published.get(session_id, 0),
                sequence,
            )
            return
        await self._coordinator.set_max_while_lock_owned(
            self._lock_name(session_id),
            self._published_key(session_id),
            sequence,
        )

    async def seal_active_range(self, session_id: str, allocated_high: int) -> None:
        """Retire the current Redis range before a durable DB writer advances."""

        if allocated_high < 0 or allocated_high > PROTOCOL_MAX_REVISION:
            raise ValueError("session revision seal is outside protocol range")
        if not self.distributed:
            return
        await self._coordinator.seal_counter_range_while_lock_owned(
            self._lock_name(session_id),
            head_key=self._head_key(session_id),
            end_key=self._lease_end_key(session_id),
            epoch_key=self._lease_epoch_key(session_id),
            floor=allocated_high,
            epoch=await self._coordinator.server_epoch(),
        )

    async def has_unpublished_live_revision(self, session_id: str) -> bool:
        """Return whether an accepted live revision still needs publication.

        The check deliberately compares only watermarks.  Callers inspect and
        flush the pending projection only when a gap exists, keeping the normal
        high-frequency path to one Redis ``MGET`` instead of a full ``HGETALL``.
        Allocated-but-unstaged revisions are valid gaps and make the item flush
        a no-op; the caller then publishes an explicit recovery boundary.
        """

        if not self.distributed:
            durable_sequence = await self._store.get_session_seq(session_id)
            return durable_sequence > self._local_published.get(session_id, 0)
        raw_head, raw_published = await self._coordinator.client.mget(
            self._head_key(session_id),
            self._published_key(session_id),
        )
        head = self._parse_counter(raw_head) or 0
        published = self._parse_counter(raw_published) or 0
        return head > published

    async def live_head(
        self,
        session_id: str,
        *,
        durable_floor: int | None = None,
    ) -> int:
        floor = (
            await self._store.get_session_seq(session_id)
            if durable_floor is None
            else durable_floor
        )
        if not self.distributed:
            return floor
        raw_head = await self._coordinator.client.get(self._head_key(session_id))
        return max(floor, self._parse_counter(raw_head) or 0)

    async def floor(self, session_id: str, sequence: int) -> None:
        """Advance the Redis live head after a durable non-timeline writer.

        This method is expected to run while ``session_fence`` is held. It is
        monotonic and never lowers either the active head or its lease end.
        """

        if sequence < 0 or sequence > PROTOCOL_MAX_REVISION:
            raise ValueError("session revision floor is outside protocol range")
        if not self.distributed:
            return
        lock_name = self._lock_name(session_id)
        await self._coordinator.set_max_while_lock_owned(
            lock_name,
            self._head_key(session_id),
            sequence,
        )
        await self._coordinator.set_max_while_lock_owned(
            lock_name,
            self._lease_end_key(session_id),
            sequence,
        )

    async def _reserve_from_redis(
        self,
        session_id: str,
        *,
        count: int,
        server_epoch: str | None = None,
    ) -> int:
        head_key = self._head_key(session_id)
        end_key = self._lease_end_key(session_id)
        epoch_key = self._lease_epoch_key(session_id)
        if server_epoch is None:
            server_epoch = await self._coordinator.server_epoch()
        (
            raw_head,
            raw_end,
            raw_epoch,
            raw_published,
        ) = await self._coordinator.client.mget(
            head_key,
            end_key,
            epoch_key,
            self._published_key(session_id),
        )
        head = self._parse_counter(raw_head)
        lease_end = self._parse_counter(raw_end)
        lease_epoch = self._as_text(raw_epoch) if raw_epoch is not None else None
        published = self._parse_counter(raw_published) or 0

        if lease_epoch == server_epoch and head is not None and head > published:
            raise SessionRevisionRepairNeeded(
                f"session revision {head} must be published before allocation"
            )

        if (
            lease_epoch != server_epoch
            or head is None
            or lease_end is None
            or head + count > lease_end
        ):
            lease_count = max(self._lease_size, count)
            lease_start, lease_end = await self._store.lease_session_revision_range(
                session_id=session_id,
                count=lease_count,
            )
            head = lease_start - 1
            async with self._coordinator.pipeline_while_lock_owned(
                self._lock_name(session_id)
            ) as pipeline:
                pipeline.set(head_key, head)
                pipeline.set(end_key, lease_end)
                pipeline.set(epoch_key, server_epoch)
            if head > published:
                raise SessionRevisionRepairNeeded(
                    f"session revision {head} must be published before allocation"
                )

        final_sequence = await self._coordinator.incrby_while_lock_owned(
            self._lock_name(session_id),
            head_key,
            count,
        )
        first_sequence = final_sequence - count + 1
        if final_sequence > lease_end:
            raise RuntimeError("session revision allocation escaped its lease")
        if final_sequence > PROTOCOL_MAX_REVISION:
            raise OverflowError("session revision exceeds the protocol limit")
        return first_sequence

    def _head_key(self, session_id: str) -> str:
        return self._coordinator.key("session-revision", session_id, "head")

    def _lease_end_key(self, session_id: str) -> str:
        return self._coordinator.key("session-revision", session_id, "lease-end")

    def _lease_epoch_key(self, session_id: str) -> str:
        return self._coordinator.key("session-revision", session_id, "lease-epoch")

    def _published_key(self, session_id: str) -> str:
        return self._coordinator.key("session-revision", session_id, "published")

    @staticmethod
    def _lock_name(session_id: str) -> str:
        return f"session-revision:{session_id}"

    @staticmethod
    def _parse_counter(value: object) -> int | None:
        if value is None:
            return None
        if isinstance(value, bytes):
            value = value.decode("utf-8")
        try:
            parsed = int(str(value))
        except ValueError as exc:
            raise RuntimeError("invalid Redis session revision counter") from exc
        if parsed < 0:
            raise RuntimeError("negative Redis session revision counter")
        return parsed

    @staticmethod
    def _as_text(value: object) -> str:
        if isinstance(value, bytes):
            return value.decode("utf-8")
        return str(value)
