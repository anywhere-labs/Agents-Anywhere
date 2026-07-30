from __future__ import annotations

import asyncio
import json
import struct
import tempfile
from pathlib import Path
from typing import Any

from connector.codex.ipc_client import CodexIpcClient, default_codex_ipc_socket_path
from connector.codex.ipc_protocol import CODEX_IPC_MAX_FRAME_BYTES, CodexIpcBroadcast


async def _read_frame(reader: asyncio.StreamReader) -> dict[str, Any]:
    header = await reader.readexactly(4)
    payload = await reader.readexactly(struct.unpack("<I", header)[0])
    value = json.loads(payload)
    assert isinstance(value, dict)
    return value


def _frame(value: dict[str, Any]) -> bytes:
    payload = json.dumps(value, separators=(",", ":")).encode()
    return struct.pack("<I", len(payload)) + payload


def test_missing_router_is_normal_and_does_not_create_socket(tmp_path: Path) -> None:
    asyncio.run(_exercise_missing_router(tmp_path))


async def _exercise_missing_router(tmp_path: Path) -> None:
    socket_path = tmp_path / "ipc.sock"
    client = CodexIpcClient(socket_path=socket_path)

    assert await client.ensure_connected() is False
    assert not socket_path.exists()


def test_default_socket_path_uses_app_server_environment() -> None:
    assert default_codex_ipc_socket_path({"CODEX_HOME": "/runtime/codex"}) == Path(
        "/runtime/codex/ipc/ipc.sock"
    )


def test_non_socket_endpoint_is_not_removed(tmp_path: Path) -> None:
    asyncio.run(_exercise_non_socket_endpoint(tmp_path))


async def _exercise_non_socket_endpoint(tmp_path: Path) -> None:
    socket_path = tmp_path / "ipc.sock"
    socket_path.write_text("not a socket", encoding="utf-8")
    client = CodexIpcClient(socket_path=socket_path)

    assert await client.ensure_connected() is False
    assert socket_path.read_text(encoding="utf-8") == "not a socket"


def test_initializes_and_sends_length_prefixed_broadcast() -> None:
    with tempfile.TemporaryDirectory(prefix="aa-ipc-", dir="/tmp") as directory:
        asyncio.run(
            asyncio.wait_for(
                _exercise_initialize_and_broadcast(Path(directory)), timeout=3
            )
        )


async def _exercise_initialize_and_broadcast(tmp_path: Path) -> None:
    socket_path = tmp_path / "ipc.sock"
    received: list[dict[str, Any]] = []
    broadcast_received = asyncio.Event()

    async def handle(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        initialize = await _read_frame(reader)
        received.append(initialize)
        response = _frame(
            {
                "type": "response",
                "requestId": initialize["requestId"],
                "resultType": "success",
                "method": "initialize",
                "result": {"clientId": "client_1"},
            }
        )
        writer.write(response[:2])
        await writer.drain()
        writer.write(response[2:])
        await writer.drain()
        received.append(await _read_frame(reader))
        broadcast_received.set()
        await reader.read()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    client = CodexIpcClient(socket_path=socket_path)
    try:
        assert await client.ensure_connected() is True
        assert client.client_id == "client_1"
        assert await client.send_broadcast(
            "thread-stream-following-changed",
            {"conversationId": "thr_1", "hostId": "local", "following": True},
        )
        await asyncio.wait_for(broadcast_received.wait(), timeout=1)
    finally:
        await asyncio.wait_for(client.close(), timeout=1)
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert received[0]["method"] == "initialize"
    assert received[0]["sourceClientId"] == "initializing-client"
    assert received[1] == {
        "type": "broadcast",
        "method": "thread-stream-following-changed",
        "sourceClientId": "client_1",
        "params": {"conversationId": "thr_1", "hostId": "local", "following": True},
        "version": 1,
    }


def test_dispatches_coalesced_messages_and_clears_state_on_eof() -> None:
    with tempfile.TemporaryDirectory(prefix="aa-ipc-", dir="/tmp") as directory:
        asyncio.run(_exercise_dispatch_and_eof(Path(directory)))


async def _exercise_dispatch_and_eof(tmp_path: Path) -> None:
    socket_path = tmp_path / "ipc.sock"
    messages: list[CodexIpcBroadcast] = []
    messages_received = asyncio.Event()
    close_connection = asyncio.Event()

    async def on_message(message) -> None:
        assert isinstance(message, CodexIpcBroadcast)
        messages.append(message)
        if len(messages) == 2:
            messages_received.set()

    async def handle(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        initialize = await _read_frame(reader)
        writer.write(
            _frame(
                {
                    "type": "response",
                    "requestId": initialize["requestId"],
                    "resultType": "success",
                    "result": {"clientId": "client_2"},
                }
            )
        )
        writer.write(
            _frame(
                {
                    "type": "broadcast",
                    "method": "client-status-changed",
                    "sourceClientId": "router",
                    "params": {
                        "clientId": "app",
                        "clientType": "app",
                        "status": "connected",
                    },
                    "version": 0,
                }
            )
            + _frame(
                {
                    "type": "broadcast",
                    "method": "ipc-connection-reset",
                    "sourceClientId": "router",
                    "params": {},
                    "version": 1,
                }
            )
        )
        await writer.drain()
        await close_connection.wait()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    client = CodexIpcClient(socket_path=socket_path, message_handler=on_message)
    try:
        assert await client.ensure_connected() is True
        await asyncio.wait_for(messages_received.wait(), timeout=1)
        assert client.is_connected
        close_connection.set()
        for _ in range(20):
            if not client.is_connected:
                break
            await asyncio.sleep(0)
        assert not client.is_connected
        assert client.client_id is None
    finally:
        await asyncio.wait_for(client.close(), timeout=1)
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)

    assert [message.method for message in messages] == [
        "client-status-changed",
        "ipc-connection-reset",
    ]


def test_oversized_frame_disconnects_client() -> None:
    with tempfile.TemporaryDirectory(prefix="aa-ipc-", dir="/tmp") as directory:
        asyncio.run(_exercise_oversized_frame(Path(directory)))


async def _exercise_oversized_frame(tmp_path: Path) -> None:
    socket_path = tmp_path / "ipc.sock"
    send_oversized_frame = asyncio.Event()

    async def handle(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        initialize = await _read_frame(reader)
        writer.write(
            _frame(
                {
                    "type": "response",
                    "requestId": initialize["requestId"],
                    "resultType": "success",
                    "result": {"clientId": "client_3"},
                }
            )
        )
        await writer.drain()
        await send_oversized_frame.wait()
        writer.write(struct.pack("<I", CODEX_IPC_MAX_FRAME_BYTES + 1))
        await writer.drain()
        await reader.read()
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_unix_server(handle, path=socket_path)
    client = CodexIpcClient(socket_path=socket_path)
    try:
        assert await client.ensure_connected() is True
        send_oversized_frame.set()
        for _ in range(20):
            if not client.is_connected:
                break
            await asyncio.sleep(0)
        assert not client.is_connected
    finally:
        await asyncio.wait_for(client.close(), timeout=1)
        server.close()
        await server.wait_closed()
        socket_path.unlink(missing_ok=True)
