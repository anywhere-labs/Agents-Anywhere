from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from connector.runtimes.dsh.bridge.host import SubscriptionRegistry
from connector.runtimes.dsh.bridge.sync import SyncRelay
from tests.dsh_sync_helpers import ingest


def test_close_cancels_blocked_ingest_before_waiting_for_subscription_cleanup():
    async def exercise():
        entered = asyncio.Event()
        cancelled = asyncio.Event()

        async def publish(*args):
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

        client = FakeBridgeClient()
        host = SimpleNamespace(publish_runtime_notifications=publish, runtime_health_update=AsyncMock())
        relay = SyncRelay(client, host)
        relay.start()
        pending = None
        closing = None
        try:
            await _ready(client, relay, 1)
            pending = asyncio.create_task(ingest(relay, {"kind": "notifications", "notifications": [
                {"method": "session.inventory.begin", "params": {"scanToken": "scan"}},
            ]}))
            await asyncio.wait_for(entered.wait(), 1)
            closing = asyncio.create_task(relay.close())
            await asyncio.wait_for(asyncio.shield(closing), 1)
            assert cancelled.is_set()
            assert pending.cancelled()
            assert relay.task.done()
            assert not relay.ingest_lock.locked()
            assert not relay._ingest_tasks
            with pytest.raises(RuntimeError, match="closing"):
                await ingest(relay, _notification_op())
            with pytest.raises(RuntimeError, match="closing"):
                await relay.serialized(lambda: host.runtime_health_update("running"))
            await relay.close()
        finally:
            if pending is not None:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
            if closing is not None:
                await asyncio.gather(closing, return_exceptions=True)
            await relay.close()

    asyncio.run(exercise())


def test_close_does_not_cancel_upload_cleanup_a_second_time():
    async def exercise():
        entered, cleaning, release, cleaned = (asyncio.Event() for _ in range(4))

        async def upload():
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cleaning.set()
                await release.wait()
                cleaned.set()
                raise

        relay = SyncRelay(FakeBridgeClient(), SimpleNamespace(runtime_health_update=AsyncMock()))
        pending = asyncio.create_task(relay.serialized(upload))
        closing = None
        try:
            await entered.wait()
            pending.cancel()
            await cleaning.wait()
            closing = asyncio.create_task(relay.close())
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            assert not pending.done(), "shutdown must let existing upload cleanup finish"
            release.set()
            await asyncio.wait_for(closing, 1)
            assert cleaned.is_set()
            assert not relay.ingest_lock.locked()
        finally:
            release.set()
            await asyncio.gather(pending, return_exceptions=True)
            if closing is not None:
                await closing
            await relay.close()

    asyncio.run(exercise())


def _notification_op() -> dict:
    return {"kind": "notifications", "notifications": [
        {"method": "session.state.updated", "params": {"sessionId": "session", "status": "idle"}},
    ]}


class _Stream:
    """One ``sync`` server stream: confirms the subscription, then waits to be broken."""

    def __init__(self, subscription_id: str) -> None:
        self.subscription_id = subscription_id
        self.failures: asyncio.Queue[BaseException] = asyncio.Queue()

    async def events(self):
        yield {"kind": "subscribed", "projectionVersion": 3, "checkpointVersion": 1}
        raise await self.failures.get()

    def fail(self, error: BaseException) -> None:
        self.failures.put_nowait(error)


class FakeBridgeClient:
    """The plugin side of the Router: streams stay open until the test breaks them."""

    def __init__(self) -> None:
        self.registry = SubscriptionRegistry()
        self.host = SimpleNamespace(registry=self.registry)
        self.connected = True
        self.streams: list[_Stream] = []
        self.requests: list[tuple[str, dict | None]] = []

    def stream(self, method, params):
        assert method == "sync"
        stream = _Stream(params["subscriptionId"])
        self.streams.append(stream)
        return stream.events()

    async def request(self, method, params=None):
        self.requests.append((method, params))
        return {"ok": True}


async def _wait_for(predicate, attempts: int = 300) -> None:
    for _ in range(attempts):
        if predicate():
            return
        await asyncio.sleep(0.005)
    raise AssertionError("condition was not met")


async def _ready(client: FakeBridgeClient, relay: SyncRelay, count: int) -> None:
    """Wait until ``count`` subscriptions were opened and the latest one is confirmed."""
    await _wait_for(lambda: len(client.streams) >= count)
    stream = client.streams[count - 1]
    await _wait_for(lambda: relay.subscription_id == stream.subscription_id and relay.confirmed.is_set())


def test_health_reports_that_fail_never_stop_the_relay():
    # The backend socket may be down while the bridge is healthy: reporting
    # "syncing" / "interrupted" / "running" must not kill the sync loop (#293).
    async def exercise():
        client = FakeBridgeClient()
        host = SimpleNamespace(
            session_state_update=AsyncMock(),
            publish_runtime_notifications=AsyncMock(),
            runtime_health_update=AsyncMock(side_effect=RuntimeError("backend websocket is not connected")),
        )
        relay = SyncRelay(client, host, retry_delay=0.01)
        relay.start()
        try:
            await _ready(client, relay, 1)
            await ingest(relay, _notification_op())
            assert relay.failures == 0
            # A broken stream interrupts the feed; the relay resubscribes instead of dying.
            client.streams[0].fail(RuntimeError("stream broke"))
            await _wait_for(lambda: relay.failures == 1)
            assert not relay.task.done()
            await _ready(client, relay, 2)
            await ingest(relay, _notification_op())
            assert relay.failures == 0
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_consecutive_failures_back_off_and_a_delivered_batch_resets_the_counter():
    async def exercise():
        client = FakeBridgeClient()
        host = SimpleNamespace(
            session_state_update=AsyncMock(), publish_runtime_notifications=AsyncMock(), runtime_health_update=AsyncMock(),
        )
        relay = SyncRelay(client, host, retry_delay=0.01)
        relay.start()
        try:
            for attempt in range(1, 4):
                await _ready(client, relay, attempt)
                client.streams[attempt - 1].fail(RuntimeError(f"stream {attempt} broke"))
                await _wait_for(lambda expected=attempt: relay.failures == expected)
            await _ready(client, relay, 4)
            assert relay.failures == 3
            await ingest(relay, _notification_op())
            assert relay.failures == 0
        finally:
            await relay.close()
    asyncio.run(exercise())


def test_exit_hook_reports_unexpected_death_but_not_a_normal_close():
    async def exercise():
        exits = []
        relay = SyncRelay(Mock(), SimpleNamespace(runtime_health_update=AsyncMock()), on_exit=lambda r, error: exits.append((r, error)))

        async def crash():
            raise RuntimeError("relay bug")

        relay.run = crash  # type: ignore[method-assign]
        relay.start()
        await asyncio.gather(relay.task, return_exceptions=True)
        await asyncio.sleep(0)
        assert len(exits) == 1 and exits[0][0] is relay and isinstance(exits[0][1], RuntimeError)

        closed = SyncRelay(Mock(), SimpleNamespace(runtime_health_update=AsyncMock()), on_exit=lambda r, error: exits.append((r, error)))

        async def wait_forever():
            await asyncio.Event().wait()

        closed.run = wait_forever  # type: ignore[method-assign]
        closed.start()
        await asyncio.sleep(0)
        await closed.close()
        await asyncio.sleep(0)
        assert len(exits) == 1
    asyncio.run(exercise())


def test_runtime_rebuilds_a_relay_that_died_from_a_bug(monkeypatch):
    from connector.runtime_protocol.models import RuntimeConfig
    from connector.runtimes.dsh import runtime as runtime_module
    from connector.runtimes.dsh.runtime import DshRuntime

    monkeypatch.setattr(runtime_module, "RELAY_RESTART_DELAY_SECONDS", 0.01)

    async def exercise():
        host = SimpleNamespace(connector_id="test", runtime_health_update=AsyncMock())
        runtime = DshRuntime(RuntimeConfig("dsh", 2), host)
        client = FakeBridgeClient()
        runtime._client = client
        dead = SyncRelay(client, host, on_exit=runtime._relay_exited)
        runtime._sync = dead

        async def crash():
            raise RuntimeError("relay bug")

        dead.run = crash  # type: ignore[method-assign]
        dead.start()
        await asyncio.gather(dead.task, return_exceptions=True)
        await asyncio.sleep(0)
        assert runtime._relay_restart_task is not None
        await asyncio.wait_for(runtime._relay_restart_task, 1)
        replacement = runtime._sync
        try:
            assert replacement is not None and replacement is not dead
            await _ready(client, replacement, 1)
            assert len(client.streams) == 1, "the replacement relay subscribes on its own"
            host.runtime_health_update.assert_awaited()

            # A relay that was closed on purpose, or a runtime that is stopping, is left alone.
            runtime._stopping = True
            runtime._relay_exited(replacement, RuntimeError("late"))
            assert runtime._relay_restart_task.done()
            runtime._stopping = False
            runtime._relay_exited(replacement, None)
            assert runtime._relay_restart_task.done()
        finally:
            if replacement is not None:
                await replacement.close()
    asyncio.run(exercise())
