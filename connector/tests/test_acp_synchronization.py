"""The ACP durable queue waits as long as it is told when its upload is deferred."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from connector.runtimes.acp.application import synchronization
from connector.server.ingest import ConnectorIngestDeferredError


class _Store:
    def __init__(self) -> None:
        self.rows = [("sequence", "key", "value")]

    def pending(self):
        return list(self.rows)

    def transaction(self):
        return SimpleNamespace(__enter__=lambda: None, __exit__=lambda *_: None)

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

    asyncio.run(run())
