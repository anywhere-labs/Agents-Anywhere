from __future__ import annotations

import asyncio
import json

from fakeredis import FakeServer
from fakeredis.aioredis import FakeRedis

from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.infra.ws_tickets import ClientWsTicketManager


def _coordinator(server: FakeServer) -> RedisCoordinator:
    return RedisCoordinator(
        prefix="test-agents-anywhere",
        client=FakeRedis(server=server, decode_responses=True),
    )


def test_ws_ticket_can_be_consumed_once_on_another_instance() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        issuer = ClientWsTicketManager(_coordinator(fake_server))
        consumer = ClientWsTicketManager(_coordinator(fake_server))

        token, _ = await issuer.issue(
            user_id="user-1",
            client_id="client-1",
            session_id="session-1",
        )

        ticket = await consumer.consume(token, session_id="session-1")
        assert ticket is not None
        assert ticket.user_id == "user-1"
        assert await issuer.consume(token, session_id="session-1") is None

    asyncio.run(exercise())


def test_ws_ticket_is_consumed_even_when_session_scope_is_wrong() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        tickets = ClientWsTicketManager(_coordinator(fake_server))
        token, _ = await tickets.issue(
            user_id="user-1",
            client_id="client-1",
            session_id="session-1",
        )

        assert await tickets.consume(token, session_id="session-2") is None
        assert await tickets.consume(token, session_id="session-1") is None

    asyncio.run(exercise())


def test_timeline_and_dashboard_events_cross_instances() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        broker_1 = TimelineBroker(
            _coordinator(fake_server),
            dashboard_debounce_seconds=0.01,
        )
        broker_2 = TimelineBroker(
            _coordinator(fake_server),
            dashboard_debounce_seconds=0.01,
        )
        await broker_1.start()
        await broker_2.start()
        try:
            timeline_queue = await broker_2.register("session-1")
            dashboard_queue = await broker_2.register_dashboard("user-1")

            await broker_1.publish(
                "session-1", {"sessionId": "session-1", "nextSeq": 4}
            )
            await broker_1.publish_dashboard(
                "user-1",
                {"reason": "session.changed", "serverTime": "now"},
            )

            timeline = json.loads(
                await asyncio.wait_for(timeline_queue.get(), timeout=1)
            )
            dashboard = json.loads(
                await asyncio.wait_for(dashboard_queue.get(), timeout=1)
            )
            assert timeline == {"sessionId": "session-1", "nextSeq": 4}
            assert dashboard["type"] == "dashboard.changed"
            assert dashboard["reason"] == "session.changed"
        finally:
            await broker_1.close()
            await broker_2.close()

    asyncio.run(exercise())


def test_distributed_lock_serializes_instances() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator_1 = _coordinator(fake_server)
        coordinator_2 = _coordinator(fake_server)
        second_acquired = asyncio.Event()

        async def acquire_second() -> None:
            async with coordinator_2.lock("runtime:connector-1:codex"):
                second_acquired.set()

        async with coordinator_1.lock("runtime:connector-1:codex"):
            task = asyncio.create_task(acquire_second())
            await asyncio.sleep(0.02)
            assert not second_acquired.is_set()
        await asyncio.wait_for(task, timeout=1)
        assert second_acquired.is_set()

    asyncio.run(exercise())


def test_distributed_lock_renews_its_lease_while_held() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator_1 = _coordinator(fake_server)
        coordinator_2 = _coordinator(fake_server)

        async with coordinator_1.lock(
            "session-revision:session-1",
            timeout_seconds=0.2,
            lease_seconds=0.09,
        ):
            await asyncio.sleep(0.16)
            try:
                async with coordinator_2.lock(
                    "session-revision:session-1",
                    timeout_seconds=0.04,
                    lease_seconds=0.09,
                ):
                    raise AssertionError("second coordinator acquired a held lock")
            except TimeoutError:
                pass

        async with coordinator_2.lock(
            "session-revision:session-1",
            timeout_seconds=0.2,
            lease_seconds=0.09,
        ):
            pass

    asyncio.run(exercise())


def test_distributed_lock_cancelled_mid_acquire_does_not_hold_the_lease() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator = _coordinator(fake_server)
        other = _coordinator(fake_server)
        applied = asyncio.Event()
        real_set = coordinator.client.set

        async def set_with_late_reply(*args, **kwargs):
            # Redis applies the SET, but the reply is still in flight when the
            # caller is cancelled.
            result = await real_set(*args, **kwargs)
            applied.set()
            await asyncio.sleep(10)
            return result

        coordinator.client.set = set_with_late_reply  # type: ignore[method-assign]

        async def hold() -> None:
            async with coordinator.lock("session-revision:session-cancelled", lease_seconds=300):
                raise AssertionError("cancelled acquisition entered the lock")

        task = asyncio.create_task(hold())
        await asyncio.wait_for(applied.wait(), timeout=1)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        assert task.cancelled()

        async with other.lock("session-revision:session-cancelled", timeout_seconds=1):
            pass
        await coordinator.close()

    asyncio.run(exercise())


def test_distributed_lock_interrupts_owner_when_renewal_fails() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator = _coordinator(fake_server)
        reached_after_failure = False

        async def fail_refresh(
            _key: str,
            _value: str,
            *,
            ttl_seconds: float,
        ) -> bool:
            assert ttl_seconds == 0.09
            return False

        coordinator.refresh_if_value = fail_refresh  # type: ignore[method-assign]
        try:
            async with coordinator.lock(
                "session-revision:session-renewal-failure",
                timeout_seconds=0.2,
                lease_seconds=0.09,
            ):
                await asyncio.sleep(0.2)
                reached_after_failure = True
        except RuntimeError as exc:
            assert "failed to renew distributed lock" in str(exc)
        else:
            raise AssertionError("renewal failure did not fail the lock owner")

        assert reached_after_failure is False

    asyncio.run(exercise())


def test_stale_lock_owner_cannot_mutate_or_publish_after_replacement() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator_1 = _coordinator(fake_server)
        coordinator_2 = _coordinator(fake_server)
        broker = TimelineBroker(coordinator_1)
        lock_name = "session-revision:session-stale-owner"
        first_acquired = asyncio.Event()
        attempt_publish = asyncio.Event()
        rejected_operations: list[str] = []

        async def stale_owner() -> str:
            try:
                async with coordinator_1.lock(
                    lock_name,
                    timeout_seconds=0.2,
                    lease_seconds=30,
                ):
                    first_acquired.set()
                    await attempt_publish.wait()
                    try:
                        async with coordinator_1.pipeline_while_lock_owned(
                            lock_name
                        ) as pipeline:
                            pipeline.incrby(coordinator_1.key("stale-counter"), 1)
                    except RuntimeError:
                        rejected_operations.append("increment")
                    try:
                        await broker.publish(
                            "session-stale-owner",
                            {
                                "sessionId": "session-stale-owner",
                                "nextSeq": 1,
                            },
                        )
                    except RuntimeError:
                        rejected_operations.append("publish")
            except RuntimeError as exc:
                return str(exc)
            raise AssertionError("stale owner release was not rejected")

        stale_task = asyncio.create_task(stale_owner())
        await first_acquired.wait()
        await coordinator_1.client.delete(coordinator_1.key("lock", lock_name))
        async with coordinator_2.lock(
            lock_name,
            timeout_seconds=0.2,
            lease_seconds=30,
        ):
            attempt_publish.set()
            error = await asyncio.wait_for(stale_task, timeout=1)

        assert "distributed lock is no longer owned" in error
        assert rejected_operations == ["increment", "publish"]
        assert (
            await coordinator_1.client.get(coordinator_1.key("stale-counter")) is None
        )

    asyncio.run(exercise())


def test_fs_download_relay_streams_between_instances() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        creator = FsDownloadRelayManager(_coordinator(fake_server))
        uploader = FsDownloadRelayManager(_coordinator(fake_server))
        consumer = FsDownloadRelayManager(_coordinator(fake_server))
        transfer = await creator.create(
            connector_id="connector-1",
            root="/repo",
            path="/repo/payload.bin",
            name="payload.bin",
            size=6,
            sha256="abc",
            media_type="application/octet-stream",
        )

        async def chunks():
            yield b"abc"
            yield b"def"

        upload_task = asyncio.create_task(
            uploader.upload(
                transfer_id=transfer.transfer_id,
                token=transfer.token,
                chunks=chunks(),
            )
        )
        streamed = [
            chunk
            async for chunk in consumer.stream(
                transfer_id=transfer.transfer_id,
                token=transfer.token,
            )
        ]

        assert await upload_task
        assert b"".join(streamed) == b"abcdef"
        assert await creator.get(transfer.transfer_id, transfer.token) is None

    asyncio.run(exercise())


def test_lock_stats_record_acquisition_and_hold() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator = _coordinator(fake_server)

        async with coordinator.lock(
            "stats:lock", timeout_seconds=1, lease_seconds=30
        ):
            await coordinator.publish_while_lock_owned("stats:lock", "channel", "{}")

        stats = coordinator.stats
        assert stats.acquisitions == 1
        assert stats.hold_ms_max > 0.0
        assert stats.wait_ms_max >= 0.0
        assert stats.timeouts == 0
        assert stats.renewal_failures == 0
        assert stats.release_mismatches == 0

    asyncio.run(exercise())


def test_lock_stats_count_acquire_timeout() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        holder = _coordinator(fake_server)
        waiter = _coordinator(fake_server)

        async with holder.lock(
            "stats:contended", timeout_seconds=1, lease_seconds=30
        ):
            try:
                async with waiter.lock(
                    "stats:contended", timeout_seconds=0.05, lease_seconds=30
                ):
                    raise AssertionError("second coordinator acquired a held lock")
            except TimeoutError:
                pass

        assert waiter.stats.timeouts == 1
        assert waiter.stats.acquisitions == 0
        assert holder.stats.acquisitions == 1

    asyncio.run(exercise())


def test_lock_stats_count_release_mismatch() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator = _coordinator(fake_server)
        error: Exception | None = None

        try:
            async with coordinator.lock(
                "stats:release", timeout_seconds=1, lease_seconds=30
            ):
                await coordinator.client.set(
                    coordinator.key("lock", "stats:release"), "someone-else"
                )
        except RuntimeError as exc:
            error = exc

        assert error is not None
        assert "no longer owned" in str(error)
        assert coordinator.stats.release_mismatches == 1

    asyncio.run(exercise())


def test_fenced_scripts_reject_a_replaced_lock_owner() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        coordinator = _coordinator(fake_server)
        failures = 0

        try:
            async with coordinator.lock(
                "fence:lost", timeout_seconds=1, lease_seconds=30
            ):
                await coordinator.client.set(
                    coordinator.key("lock", "fence:lost"), "someone-else"
                )
                attempts = (
                    coordinator.publish_while_lock_owned(
                        "fence:lost", "channel", "{}"
                    ),
                )
                for attempt in attempts:
                    try:
                        await attempt
                    except RuntimeError as exc:
                        assert "no longer owned" in str(exc)
                        failures += 1
                    else:
                        raise AssertionError(
                            "fenced script mutated after lock replacement"
                        )
        except RuntimeError as exc:
            assert "no longer owned" in str(exc)

        assert failures == 1

    asyncio.run(exercise())


def test_remote_disconnect_waits_for_the_notification_owner_to_abort():
    from agent_server.api.connector_ingress import _ConnectorNotificationPump
    from agent_server.infra.connector_rpc import ConnectorRpcManager

    async def run():
        fake_server = FakeServer()
        owner = ConnectorRpcManager(_coordinator(fake_server), instance_id="owner")
        caller = ConnectorRpcManager(_coordinator(fake_server), instance_id="caller")
        await owner.start()
        await caller.start()
        entered = asyncio.Event()

        class Socket:
            async def close(self, **kwargs):
                pass

        class Blocking:
            async def handle_notification_message(self, **kwargs):
                entered.set()
                await asyncio.Event().wait()

        connection = await owner.register("conn", Socket())
        pump = _ConnectorNotificationPump("conn", Blocking())
        connection.abort_notifications = pump.abort
        pump.start()
        pump.enqueue_message({"method": "session.source.updated", "params": {"runtime": "codex", "sessionId": "session"}})
        await entered.wait()
        assert await asyncio.wait_for(caller.disconnect("conn", reason="connector deleted"), 2)
        assert not await caller.is_online("conn")
        assert pump._pending == 0
        await caller.close()
        await owner.close()
        await caller._coordinator.close()
        await owner._coordinator.close()

    asyncio.run(run())
