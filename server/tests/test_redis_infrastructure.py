from __future__ import annotations

import asyncio
import json

from fakeredis import FakeServer
from fakeredis.aioredis import FakeRedis

from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.terminal_stream_hub import TerminalStreamHub
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.infra.ws_tickets import ClientWsTicketManager
from agent_server.services.shell_tasks import ShellTaskManager


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


def test_shell_task_completion_crosses_instances() -> None:
    async def exercise() -> None:
        fake_server = FakeServer()
        creator = ShellTaskManager(_coordinator(fake_server))
        receiver = ShellTaskManager(_coordinator(fake_server))
        task = await creator.create(
            session_id="browse-1",
            connector_id="connector-1",
            command="pwd",
            cwd="/repo",
            timeout_ms=30_000,
        )
        waiter = asyncio.create_task(
            creator.wait(task.id, session_id="browse-1", timeout_seconds=1)
        )
        await asyncio.sleep(0)

        completed = await receiver.complete(
            task.id,
            session_id="browse-1",
            connector_id="connector-1",
            status="completed",
            result={"exitCode": 0, "stdout": "/repo\n"},
        )

        assert completed is not None
        result = await waiter
        assert result.status == "completed"
        assert result.result == {"exitCode": 0, "stdout": "/repo\n"}
        popped = await creator.pop(task.id, session_id="browse-1")
        assert popped.status == "completed"
        try:
            await receiver.get(task.id, session_id="browse-1")
        except KeyError:
            pass
        else:
            raise AssertionError("completed task was not consumed")

    asyncio.run(exercise())


def test_terminal_stream_events_cross_instances() -> None:
    class Socket:
        def __init__(self) -> None:
            self.messages: asyncio.Queue[dict] = asyncio.Queue()

        async def send_json(self, payload: dict) -> None:
            await self.messages.put(payload)

    async def exercise() -> None:
        fake_server = FakeServer()
        publisher = TerminalStreamHub(_coordinator(fake_server))
        subscriber = TerminalStreamHub(_coordinator(fake_server))
        await publisher.start()
        await subscriber.start()
        socket = Socket()
        try:
            await subscriber.attach("connector-1", "terminal-1", socket)  # type: ignore[arg-type]
            await subscriber.mark_ready("connector-1", "terminal-1", socket)  # type: ignore[arg-type]
            await publisher.publish_output(
                "connector-1",
                {"terminalId": "terminal-1", "dataBase64": "b2s=", "seq": 2},
            )
            assert await asyncio.wait_for(socket.messages.get(), timeout=1) == {
                "type": "output",
                "data": "b2s=",
                "seq": 2,
            }
        finally:
            await publisher.close()
            await subscriber.close()

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
