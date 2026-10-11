from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.dsh.bridge.client import BridgeClient
from connector.runtimes.dsh.discovery import BridgeEndpoint
from connector.runtimes.dsh.provider_config import dsh_capabilities
from connector.runtimes.dsh.runtime import DshRuntime


def test_steer_capability_follows_the_bridge_declaration() -> None:
    reported = {
        "capabilities": [
            {"capabilityId": "session.send_message", "supported": True, "available": True, "allowed": True},
            {"capabilityId": "session.queue", "supported": True, "available": True, "allowed": True},
            {"capabilityId": "session.steer", "supported": True, "available": True, "allowed": True},
        ]
    }
    mapped = dsh_capabilities(reported)
    assert mapped["steerTurn"] is True
    assert mapped["queueTurn"] is True
    # A bridge that declares the message channel but not steering/queueing keeps
    # the old read-mostly behaviour: clients gate those affordances on the flags.
    without = {"capabilities": [{"capabilityId": "session.send_message", "supported": True, "available": True, "allowed": True}]}
    assert dsh_capabilities(without)["steerTurn"] is False
    assert dsh_capabilities(without)["queueTurn"] is False
    assert dsh_capabilities({"capabilities": []})["steerTurn"] is False
    assert dsh_capabilities({"capabilities": []})["queueTurn"] is False


@asynccontextmanager
async def steer_bridge(tmp_path: Path) -> AsyncIterator[tuple[DshRuntime, list[dict[str, Any]]]]:
    """Minimal JSON-RPC peer that records the steer request the adapter sends."""

    requests: list[dict[str, Any]] = []
    writers: list[asyncio.StreamWriter] = []

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        writers.append(writer)
        try:
            while line := await reader.readline():
                request = json.loads(line)
                requests.append(request)
                method, params = request["method"], request.get("params", {})
                if method == "initialize":
                    result: Any = {"identity": {"runtime": "dsh", "runtimeVersion": "test", "protocolVersion": "1.0"}}
                elif method == "session.steer":
                    assert params["content"] == "改一下方向" and params["clientMessageId"] == "msg-steer-1"
                    assert params["sessionId"] == "sess" and params["externalSessionId"] == "native"
                    result = {"accepted": True, "sessionId": "sess", "externalSessionId": "native"}
                else:
                    raise AssertionError(f"unexpected request {method}")
                writer.write(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}).encode() + b"\n")
                await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async def ignore(*_args: Any) -> None:
        return None

    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    client = BridgeClient(
        endpoint=BridgeEndpoint("127.0.0.1", server.sockets[0].getsockname()[1], "token", 1, tmp_path / "endpoint.json"),
        connector_id="test", client_version="test", startup_timeout=1, request_timeout=1,
        notification_handler=ignore, exit_handler=ignore,
    )
    runtime = DshRuntime(RuntimeConfig("dsh", 2), SimpleNamespace(connector_id="test"))
    await client.start()
    runtime._client = client
    try:
        yield runtime, requests
    finally:
        await client.close()
        server.close()
        await server.wait_closed()
        for writer in writers:
            writer.close()
            await writer.wait_closed()


def test_steer_turn_splices_into_the_running_turn(tmp_path: Path) -> None:
    async def run() -> None:
        async with steer_bridge(tmp_path) as (runtime, requests):
            result = await runtime.steer_turn("sess", "native", "改一下方向", client_message_id="msg-steer-1")
            assert result.ok
            steer = [r for r in requests if r["method"] == "session.steer"]
            assert len(steer) == 1
            # Steering never carries selections or a workspace: it must not
            # reconfigure the turn that is already in flight.
            assert "selections" not in steer[0]["params"] or steer[0]["params"]["selections"] == {}
            assert steer[0]["params"].get("cwd") is None

    asyncio.run(run())
