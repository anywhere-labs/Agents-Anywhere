from __future__ import annotations

import asyncio
import io
import json
from typing import Any

from connector import json_rpc
from connector.json_rpc import JsonRpcError, JsonRpcStdioServer


class MemoryWriter:
    def __init__(self) -> None:
        self.lines: list[dict[str, Any]] = []

    def write(self, data: bytes) -> None:
        self.lines.append(json.loads(data))

    async def drain(self) -> None:
        return None


def test_json_rpc_server_handles_request_notification_and_errors() -> None:
    async def exercise() -> list[dict[str, Any]]:
        reader = asyncio.StreamReader()
        writer = MemoryWriter()
        notifications: list[Any] = []

        async def echo(params: Any) -> Any:
            return {"params": params}

        def fail(_params: Any) -> Any:
            raise JsonRpcError(-32010, "custom failure", {"reason": "test"})

        server = JsonRpcStdioServer(
            reader,
            writer,  # type: ignore[arg-type]
            {
                "echo": echo,
                "notifyOnly": lambda params: notifications.append(params),
                "fail": fail,
            },
        )

        await server.handle_line(b'{"jsonrpc":"2.0","id":1,"method":"echo","params":{"ok":true}}\n')
        await server.handle_line(b'{"jsonrpc":"2.0","method":"notifyOnly","params":{"seen":true}}\n')
        await server.handle_line(b'{"jsonrpc":"2.0","id":2,"method":"missing"}\n')
        await server.handle_line(b'{"jsonrpc":"2.0","id":3,"method":"fail"}\n')
        await server.handle_line(b"not-json\n")

        assert notifications == [{"seen": True}]
        return writer.lines

    lines = asyncio.run(exercise())

    assert lines[0] == {"jsonrpc": "2.0", "id": 1, "result": {"params": {"ok": True}}}
    assert lines[1]["error"]["code"] == -32601
    assert lines[2]["error"] == {"code": -32010, "message": "custom failure", "data": {"reason": "test"}}
    assert lines[3]["error"]["code"] == -32700


def test_open_stdio_server_uses_threaded_stdio_on_windows(monkeypatch) -> None:
    class FakeStdin:
        buffer = io.BytesIO(b'{"jsonrpc":"2.0","id":1,"method":"echo","params":{"ok":true}}\n')

    class FakeStdout:
        buffer = io.BytesIO()

    async def exercise() -> list[dict[str, Any]]:
        stdout = FakeStdout()
        monkeypatch.setattr(json_rpc.sys, "platform", "win32")
        monkeypatch.setattr(json_rpc.sys, "stdin", FakeStdin())
        monkeypatch.setattr(json_rpc.sys, "stdout", stdout)

        server = await json_rpc.open_stdio_server({"echo": lambda params: {"params": params}})
        await asyncio.wait_for(server.serve_forever(), timeout=1)
        return [json.loads(line) for line in stdout.buffer.getvalue().splitlines()]

    lines = asyncio.run(exercise())

    assert lines == [{"jsonrpc": "2.0", "id": 1, "result": {"params": {"ok": True}}}]
