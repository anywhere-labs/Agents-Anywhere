from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fakeredis import FakeServer
from fakeredis.aioredis import FakeRedis
from fastapi import WebSocketDisconnect

from agent_server.api.connector_ingress import connector_terminal_relay_ws
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.terminal_broker import TerminalBroker, TerminalRelayError
from agent_server.infra.terminal_stream_hub import TerminalStreamHub
from agent_server.services.terminal_relay import TerminalRelayService


class Socket:
    def __init__(self):
        self.sent = asyncio.Queue()
        self.closed = False

    async def send_json(self, payload):
        await self.sent.put(payload)

    async def close(self, **kwargs):
        self.closed = True

    async def receive(self):
        return await asyncio.wait_for(self.sent.get(), timeout=1)


async def register(broker, tid="t"):
    return await broker.register(
        terminal_id=tid,
        session_id="browse_c",
        connector_id="c",
        label="Shell",
        cwd="/repo",
        shell="",
        cols=80,
        rows=24,
        purpose="relay",
        relay_mode="attach",
    )


def test_relay_request_response_crosses_workers_and_fences_replaced_socket():
    async def run():
        redis = FakeServer()
        brokers = [
            TerminalBroker(
                RedisCoordinator(client=FakeRedis(server=redis, decode_responses=True))
            )
            for _ in range(3)
        ]
        requester, owner, replacement = brokers
        for broker in brokers:
            await broker.start()
        try:
            term = await register(requester)
            socket = Socket()
            await owner.attach_connector(term.id, term.relay_token, socket)
            assert (await owner.get(term.id)).relay_mode == "attach"
            task = asyncio.create_task(
                requester.request_relay("t", {"type": "snapshot"})
            )
            frame = await socket.receive()
            # A response from a different terminal cannot satisfy this request.
            await owner.relay_response(
                "other",
                {"requestId": frame["requestId"], "ok": True, "result": "wrong"},
            )
            await owner.relay_response(
                "t", {"requestId": frame["requestId"], "ok": True, "result": {"seq": 9}}
            )
            assert await asyncio.wait_for(task, 1) == {"seq": 9}
            newer = Socket()
            await replacement.attach_connector("t", term.relay_token, newer)
            assert not await owner.owns_connector_socket("t", socket)
            assert await replacement.owns_connector_socket("t", newer)
            await owner.detach_connector("t", socket)
            assert await requester.has_connector("t")
            task = asyncio.create_task(
                requester.request_relay("t", {"type": "input", "data": "Cg=="})
            )
            frame = await newer.receive()
            await replacement.relay_response(
                "t",
                {
                    "requestId": frame["requestId"],
                    "ok": False,
                    "error": {"code": 404, "message": "terminal not found"},
                },
            )
            with pytest.raises(TerminalRelayError) as error:
                await asyncio.wait_for(task, 1)
            assert error.value.status_code == 404
            assert requester._relay_requests == {}
            # Control reconnection preserves V2 terminals; revocation removes them.
            assert await requester.remove_ephemeral_for_connector("c") == []
            await requester.remove_relays_for_connector("c")
            assert await requester.get("t") is None
        finally:
            for broker in brokers:
                await broker.close()

    asyncio.run(run())


@pytest.mark.parametrize("slow_send", [False, True])
def test_relay_write_timeout_does_not_retry_or_leak_request(slow_send):
    async def run():
        broker = TerminalBroker()
        term = await register(broker)
        socket = Socket()
        if slow_send:

            async def send(payload):
                await socket.sent.put(payload)
                await asyncio.Event().wait()

            socket.send_json = send
        await broker.attach_connector("t", term.relay_token, socket)
        with pytest.raises(TerminalRelayError) as error:
            await broker.request_relay(
                "t", {"type": "input", "data": "Cg=="}, timeout=0.01
            )
        assert error.value.status_code == 504
        assert socket.sent.qsize() == 1
        assert broker._relay_requests == {}
        await broker.close()

    asyncio.run(run())


def test_live_relay_needs_no_control_rpc_and_rejects_another_connector():
    async def run():
        broker = TerminalBroker()
        term = await register(broker)
        await broker.attach_connector("t", term.relay_token, Socket())
        service = TerminalRelayService(object(), object(), broker)
        assert (await service.ensure("c", "t")).id == "t"
        with pytest.raises(TerminalRelayError) as error:
            await service.ensure("other", "t")
        assert error.value.status_code == 404
        await broker.close()

    asyncio.run(run())


def test_snapshot_boundary_deduplicates_pending_output_and_reconnect_replays():
    async def run():
        hub = TerminalStreamHub()
        socket = Socket()
        try:
            await hub.attach("c", "t", socket)
            await hub.publish_relay(
                "c", "t", {"type": "replay", "seq": 3, "data": "old"}
            )
            await hub.publish_relay(
                "c", "t", {"type": "output", "seq": 4, "data": "already in snapshot"}
            )
            await hub.publish_relay(
                "c", "t", {"type": "output", "seq": 5, "data": "new"}
            )
            await hub.mark_ready("c", "t", socket, snapshot_seq=4)
            assert await socket.receive() == {"type": "output", "seq": 5, "data": "new"}
            await hub.publish_relay(
                "c", "t", {"type": "replay", "seq": 8, "data": "catch up"}
            )
            await hub.publish_relay(
                "c", "t", {"type": "output", "seq": 7, "data": "duplicate"}
            )
            await hub.publish_relay("c", "t", {"type": "exit", "exitCode": 0})
            assert (await socket.receive())["seq"] == 8
            assert (await socket.receive())["type"] == "exit"
            assert socket.sent.empty()
        finally:
            await hub.close()

    asyncio.run(run())


def test_slow_browser_does_not_block_other_terminal_or_browser():
    async def run():
        hub = TerminalStreamHub()
        blocked = asyncio.Event()
        slow, fast, other = Socket(), Socket(), Socket()

        async def stuck(payload):
            await blocked.wait()

        slow.send_json = stuck
        try:
            for tid, socket in [("t", slow), ("t", fast), ("other", other)]:
                await hub.attach("c", tid, socket)
                await hub.mark_ready("c", tid, socket)
            await hub.publish_relay(
                "c", "t", {"type": "output", "seq": 1, "data": "first"}
            )
            assert (await fast.receive())["seq"] == 1
            await hub.publish_relay(
                "c", "other", {"type": "output", "seq": 1, "data": "other"}
            )
            assert (await other.receive())["data"] == "other"
            for seq in range(2, 132):
                await hub.publish_relay(
                    "c", "t", {"type": "output", "seq": seq, "data": "next"}
                )
                assert (await fast.receive())["seq"] == seq
            blocked.set()
            async with asyncio.timeout(1):
                while not slow.closed:
                    await asyncio.sleep(0.005)
            assert not fast.closed
        finally:
            blocked.set()
            await hub.close()

    asyncio.run(run())


def test_relay_ingress_attaches_existing_terminal_and_bypasses_notification_dispatch():
    async def run():
        broker, hub = TerminalBroker(), TerminalStreamHub()
        term = await register(broker)
        browser = Socket()
        await hub.attach("c", "t", browser)
        await hub.mark_ready("c", "t", browser)

        async def get_connector(cid):
            assert cid == "c"
            return object()

        class Relay(Socket):
            def __init__(self):
                super().__init__()
                self.query_params = {"token": term.relay_token}
                self.app = SimpleNamespace(
                    state=SimpleNamespace(
                        store=SimpleNamespace(get_connector=get_connector),
                        terminal_stream_hub=hub,
                    )
                )
                self.messages = iter(
                    [
                        {"type": "ready", "pid": 123},
                        {"type": "replay", "seq": 2, "data": "YWI="},
                        {"type": "output", "seq": 3, "data": "Yw=="},
                        {"type": "exit", "exitCode": 0},
                        {"type": "response", "requestId": "late", "ok": True},
                    ]
                )
                self.received = 0

            async def accept(self):
                pass

            async def send_json(self, payload):
                if payload["type"] == "start":
                    assert not await broker.has_connector("t")
                await super().send_json(payload)

            async def receive_json(self):
                try:
                    frame = next(self.messages)
                    self.received += 1
                    return frame
                except StopIteration:
                    raise WebSocketDisconnect() from None

        relay = Relay()
        try:
            await connector_terminal_relay_ws(relay, "t", broker)
            assert (await relay.receive())["mode"] == "attach"
            assert (await browser.receive())["type"] == "replay"
            assert (await browser.receive())["type"] == "output"
            assert (await browser.receive())["type"] == "exit"
            assert relay.received == 5  # A natural PTY exit doesn't close the relay.
            assert (await broker.get("t")).scrollback_bytes == 0
        finally:
            await hub.close()
            await broker.close()

    asyncio.run(run())
