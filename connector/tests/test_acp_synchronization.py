"""The ACP durable queue waits as long as it is told when its upload is deferred."""

from __future__ import annotations

import asyncio
import contextlib
from types import SimpleNamespace

from connector.runtimes.acp.application import synchronization
from connector.server.ingest import ConnectorIngestDeferredError


class _Store:
    def __init__(self) -> None:
        self.rows = [("sequence", "key", "value")]

    def pending(self):
        return list(self.rows)

    def transaction(self):
        return contextlib.nullcontext()

    def acknowledge(self, keys):
        self.rows.clear()


def test_a_deferred_upload_makes_the_queue_wait_as_told_instead_of_asking_again_every_second(monkeypatch):
    delays: list[float] = []
    asked: list[str] = []

    async def sleep(delay: float) -> None:
        delays.append(delay)
        await asyncio.sleep(0)  # yield, as a real sleep would

    monkeypatch.setattr(synchronization, "asyncio", SimpleNamespace(
        sleep=sleep, Lock=asyncio.Lock, create_task=asyncio.create_task, CancelledError=asyncio.CancelledError,
    ))

    async def publish(rows):
        asked.extend(rows)
        raise ConnectorIngestDeferredError(7.0)

    async def run() -> None:
        service = synchronization.SynchronizationService(_Store(), publish)
        service.start()
        for _ in range(2000):
            if len(asked) >= 3:
                break
            await asyncio.sleep(0.001)
        await service.close()
        assert len(asked) >= 3 and set(asked) == {"value"}, "the row stays at the head of the queue"
        assert delays[:3] == [7.0] * 3, "each refusal says how long: the queue waits that long, not a second"
        assert service.last_error == "ConnectorIngestDeferredError"
        assert service.stalls == 0, "refused unsent behind another upload's stall is no stall of this queue"

    asyncio.run(run())


def _queue(monkeypatch, publish):
    """A synchronization service whose sleeps only record, with the delays they were asked for."""
    delays: list[float] = []
    asked: list[list] = []

    async def sleep(delay: float) -> None:
        delays.append(delay)
        await asyncio.sleep(0)

    monkeypatch.setattr(synchronization, "asyncio", SimpleNamespace(
        sleep=sleep, Lock=asyncio.Lock, create_task=asyncio.create_task, CancelledError=asyncio.CancelledError,
    ))

    async def publishing(rows):
        asked.append(list(rows))
        await publish(rows)

    return synchronization.SynchronizationService(_Store(), publishing), delays, asked


def test_an_upload_whose_own_body_stalled_makes_the_queue_wait_a_backoff_of_its_own_that_doubles(monkeypatch):
    """Sent again as soon as the ingest client's cool-down is over, a page too much for the path only
    stalls again (23 times in 22 minutes on a polling runtime with the cool-down alone)."""

    async def publish(rows):
        raise ConnectorIngestDeferredError(60.0, stalled=True)

    async def run() -> None:
        service, delays, asked = _queue(monkeypatch, publish)
        service.start()
        for _ in range(2000):
            if len(asked) >= 5:
                break
            await asyncio.sleep(0.001)
        await service.close()
        assert len(asked) >= 5
        assert delays[:5] == [600.0, 1200.0, 2400.0, 3600.0, 3600.0], "ten minutes, doubling, an hour at most"
        assert service.last_error == "ConnectorIngestDeferredError"

    asyncio.run(run())


def test_a_queue_that_stalled_for_weeks_waits_the_cap_and_not_an_overflow(monkeypatch):
    """2 ** (stalls - 1) with stalls in the thousands does not fit a float: the exponent is bounded."""

    async def publish(rows):
        raise ConnectorIngestDeferredError(60.0, stalled=True)

    service, _, _ = _queue(monkeypatch, publish)
    service.stalls = 5000   # weeks of stalls without an upload getting through
    assert service._deferred_sleep(ConnectorIngestDeferredError(60.0, stalled=True)) == 3600.0


def test_the_queues_own_stall_count_starts_over_once_an_upload_gets_through(monkeypatch):
    outcomes = ["stall", "through"]  # then every upload stalls again

    async def publish(rows):
        if (outcomes.pop(0) if outcomes else "stall") == "stall":
            raise ConnectorIngestDeferredError(60.0, stalled=True)

    async def run() -> None:
        service, delays, asked = _queue(monkeypatch, publish)
        store = service.store
        service.start()
        for _ in range(4000):
            # The first fact got through: a later one of the same queue stalls.
            if len(asked) == 2 and not store.rows:
                store.rows.append(("later", "key2", "value2"))
            if len(asked) >= 3:
                break
            await asyncio.sleep(0.001)
        await service.close()
        assert len(asked) >= 3 and [key for _, key, _ in store.rows] == ["key2"], "the row that got through was acknowledged"
        # (The queue's idle 0.1 s pauses are recorded too.)
        waits = [delay for delay in delays if delay != 0.1]
        assert waits[:2] == [600.0, 600.0], "the stall after an upload got through is a first again"

    asyncio.run(run())
