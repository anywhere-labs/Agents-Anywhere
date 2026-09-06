from __future__ import annotations

import asyncio
import base64
import json
from contextlib import suppress
from queue import Queue
from types import SimpleNamespace

import pytest

from connector.local.terminal import TerminalBackend, TerminalNotFoundError
from connector.server.client import BackendRpcClient
from connector.server.terminal_relay import TerminalRelayRunner


class PtyBackend(TerminalBackend):
    def __init__(self):
        self.notifications = []

        async def notify(*args):
            self.notifications.append(args)
            await asyncio.Event().wait()  # Simulate a stalled control socket.

        super().__init__(notify=notify)
        self.output_bytes = Queue()
        self.spawn_count = 0
        self.writes = []

    def _spawn(self, *args, **kwargs):
        self.spawn_count += 1
        return SimpleNamespace(pid=123)

    def _read(self, pty):
        return self.output_bytes.get(timeout=5)

    def _write_all(self, pty, data):
        self.writes.append(data)

    def _setwinsize(self, *args):
        pass

    def _terminate(self, pty):
        self.output_bytes.put(b"")

    def _close(self, pty):
        self.output_bytes.put(b"")

    def _wait_exit_code(self, pty):
        return 0


class RelaySocket:
    def __init__(self, start):
        self.incoming = asyncio.Queue()
        self.incoming.put_nowait(start)
        self.sent = asyncio.Queue()
        self.send_gate = asyncio.Event()
        self.send_gate.set()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def recv(self):
        message = await self.incoming.get()
        if isinstance(message, Exception):
            raise message
        return json.dumps(message)

    def __aiter__(self):
        return self

    async def __anext__(self):
        return await self.recv()

    async def send(self, raw):
        await self.send_gate.wait()
        await self.sent.put(json.loads(raw))

    async def receive(self, kind):
        async with asyncio.timeout(2):
            while True:
                frame = await self.sent.get()
                if frame["type"] == kind:
                    return frame


async def wait_seq(backend, seq):
    async with asyncio.timeout(2):
        while (await backend.snapshot({"terminalId": "t"}))["seq"] < seq:
            await asyncio.sleep(0.005)


def test_relay_reconnects_to_same_pty_and_replays_without_control_notifications(
    tmp_path, monkeypatch
):
    async def run():
        backend = PtyBackend()
        await backend.create(
            {
                "terminalId": "t",
                "sessionId": "browse_c",
                "root": str(tmp_path),
                "outputTransport": "relay",
                "persistent": True,
            }
        )
        backend.output_bytes.put(b"before")
        await wait_seq(backend, 1)
        sockets = [
            RelaySocket(
                {
                    "type": "start",
                    "mode": "attach",
                    "terminalId": "t",
                    "sessionId": "browse_c",
                }
            )
            for _ in range(2)
        ]
        connections = []

        def connect(*args, **kwargs):
            ws = sockets[len(connections)]
            connections.append(ws)
            return ws

        monkeypatch.setattr(
            "connector.server.terminal_relay.websockets.connect", connect
        )
        task = asyncio.create_task(
            TerminalRelayRunner(
                "http://localhost:8000", SimpleNamespace(terminal=backend)
            ).run("t", "secret", attach=True)
        )
        try:
            first = await sockets[0].receive("replay")
            assert base64.b64decode(first["data"]) == b"before"
            await sockets[0].incoming.put(OSError("transport lost"))
            backend.output_bytes.put(b" during disconnect")
            await wait_seq(backend, 2)
            replay = await sockets[1].receive("replay")
            assert replay["seq"] == 2
            assert base64.b64decode(replay["data"]) == b"before during disconnect"
            await sockets[1].incoming.put(
                {"type": "input", "data": "Cg==", "requestId": "write"}
            )
            assert (await sockets[1].receive("response"))["ok"] is True
            assert backend.writes == [b"\n"]
            await sockets[1].incoming.put(
                {"type": "resize", "cols": 120, "rows": 40, "requestId": "resize"}
            )
            assert (await sockets[1].receive("response"))["result"]["cols"] == 120
            backend.output_bytes.put(b"")
            assert (await sockets[1].receive("exit"))["exitCode"] == 0
            # Exited terminals still support snapshots until their normal TTL.
            await sockets[1].incoming.put({"type": "snapshot", "requestId": "snapshot"})
            assert (await sockets[1].receive("response"))["result"]["terminal"][
                "status"
            ] == "exited"
            assert backend.spawn_count == 1
            assert backend.notifications == []
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            await backend.close({"terminalId": "t"})

    asyncio.run(run())


def test_slow_relay_does_not_block_pty_and_catches_up_after_buffer_overflow(
    tmp_path, monkeypatch
):
    async def run():
        backend = PtyBackend()
        await backend.create(
            {
                "terminalId": "t",
                "sessionId": "s",
                "root": str(tmp_path),
                "outputTransport": "relay",
            }
        )
        socket = RelaySocket(
            {"type": "start", "mode": "attach", "terminalId": "t", "sessionId": "s"}
        )
        monkeypatch.setattr(
            "connector.server.terminal_relay.websockets.connect", lambda *a, **k: socket
        )
        runner = TerminalRelayRunner(
            "http://localhost:8000", SimpleNamespace(terminal=backend)
        )
        task = asyncio.create_task(runner._connect("ws://localhost/relay", "t"))
        try:
            await socket.receive("replay")
            socket.send_gate.clear()
            for _ in range(80):
                backend.output_bytes.put(b"x" * 8192)
            await wait_seq(backend, 80)
            assert not task.done()
            socket.send_gate.set()
            replay = await socket.receive("replay")
            assert replay["seq"] == 80
            assert len(base64.b64decode(replay["data"])) == 512 * 1024
            assert backend.notifications == []
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            await backend.close({"terminalId": "t"})

    asyncio.run(run())


def test_attach_checks_scope_and_stale_release_cannot_detach_new_sink(tmp_path):
    async def run():
        backend = PtyBackend()
        await backend.create(
            {
                "terminalId": "t",
                "sessionId": "s",
                "root": str(tmp_path),
                "outputTransport": "relay",
            }
        )
        events = []

        async def old(*args):
            raise AssertionError("old sink used")

        async def new(*args):
            events.append(args)

        try:
            with pytest.raises(TerminalNotFoundError):
                await backend.attach(
                    {"terminalId": "t", "sessionId": "other"}, output=old
                )
            await backend.attach({"terminalId": "t", "sessionId": "s"}, output=old)
            await backend.attach({"terminalId": "t", "sessionId": "s"}, output=new)
            await backend.release({"terminalId": "t"}, output=old)
            backend.output_bytes.put(b"new")
            await wait_seq(backend, 1)
            assert len(events) == 1
            await backend.release({"terminalId": "t"}, output=new)
            backend.output_bytes.put(b"buffered")
            await wait_seq(backend, 2)
            assert len(events) == 1
            assert backend.notifications == []
        finally:
            await backend.close({"terminalId": "t"})

    asyncio.run(run())


def test_duplicate_relay_connects_share_task_and_new_token_replaces_it():
    async def run():
        client = object.__new__(BackendRpcClient)
        client._terminal_relay_lock = asyncio.Lock()
        client._terminal_relay_tasks = {}
        client._background_tasks = set()
        client.local_ops = SimpleNamespace(
            terminal=SimpleNamespace(prepare_relay=lambda p: None)
        )
        starts = []

        async def relay(tid, token, **kwargs):
            starts.append(token)
            await asyncio.Event().wait()

        client._run_terminal_relay = relay
        params = {"terminalId": "t", "sessionId": "s", "token": "one", "mode": "attach"}
        await asyncio.gather(*(client.start_terminal_relay(params) for _ in range(3)))
        await asyncio.sleep(0)
        assert starts == ["one"]
        await asyncio.gather(
            *(client.start_terminal_relay({**params, "token": "two"}) for _ in range(3))
        )
        await asyncio.sleep(0)
        assert starts == ["one", "two"]
        tasks = list(client._background_tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    asyncio.run(run())
