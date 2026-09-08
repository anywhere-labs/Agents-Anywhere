from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from connector.runtimes.dsh import discovery


@pytest.mark.parametrize("valid_token", [True, False])
def test_windows_discovery_authenticates_without_signalling_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, valid_token: bool
) -> None:
    kill = Mock(
        side_effect=AssertionError("Discovery must not signal Windows processes")
    )
    monkeypatch.setattr(discovery, "os", SimpleNamespace(name="nt", kill=kill))

    async def run() -> None:
        methods: list[str] = []

        async def handle(
            reader: asyncio.StreamReader, writer: asyncio.StreamWriter
        ) -> None:
            try:
                while line := await reader.readline():
                    request = json.loads(line)
                    method = request["method"]
                    methods.append(method)
                    response = {"jsonrpc": "2.0", "id": request["id"]}
                    if method == "initialize":
                        if request["params"]["authToken"] != "expected-token":
                            response["error"] = {
                                "code": -32001,
                                "message": "Unauthorized",
                            }
                        else:
                            response["result"] = {
                                "identity": {
                                    "runtime": "dsh",
                                    "protocolVersion": "1.0",
                                    "bridgeVersion": "test",
                                }
                            }
                    else:
                        response["result"] = {}
                    writer.write(json.dumps(response).encode() + b"\n")
                    await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        endpoint = tmp_path / "agents-anywhere/bridge/endpoint.json"
        endpoint.parent.mkdir(parents=True)
        endpoint.write_text(
            json.dumps(
                {
                    "version": 1,
                    "host": "127.0.0.1",
                    "port": port,
                    "pid": 123456,
                    "token": "expected-token" if valid_token else "wrong-token",
                }
            ),
            encoding="utf-8",
        )
        try:
            result = await discovery.discover({"dshHome": str(tmp_path)})
            assert result.available is valid_token
            assert ("ping" in methods) is valid_token
            kill.assert_not_called()
        finally:
            server.close()
            await server.wait_closed()

        result = await discovery.discover({"dshHome": str(tmp_path)})
        assert not result.available
        assert result.reason
        kill.assert_not_called()

    asyncio.run(run())
