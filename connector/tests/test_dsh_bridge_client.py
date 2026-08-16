from __future__ import annotations

import asyncio
import json
from pathlib import Path

from connector.runtimes.dsh.bridge.client import BridgeClient
from connector.runtimes.dsh.discovery import BridgeEndpoint


def test_bridge_client_handshake_notification_and_disconnect(tmp_path: Path) -> None:
    async def run() -> None:
        notifications: list[tuple[str, dict[str, object]]] = []
        exits: list[int | None] = []
        saw_token = False

        async def handle(
            reader: asyncio.StreamReader, writer: asyncio.StreamWriter
        ) -> None:
            nonlocal saw_token
            while line := await reader.readline():
                request = json.loads(line)
                method = request.get("method")
                if method == "initialize":
                    saw_token = request["params"].get("authToken") == "test-token"
                    writer.write(
                        json.dumps(
                            {
                                "jsonrpc": "2.0",
                                "method": "runtime.capabilities.update",
                                "params": {
                                    "runtime": "dsh",
                                    "revision": "1",
                                    "capabilities": [],
                                },
                            }
                        ).encode()
                        + b"\n"
                    )
                    response = {
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "result": {
                            "identity": {
                                "runtime": "dsh",
                                "runtimeVersion": "test",
                                "protocolVersion": "1.0",
                            }
                        },
                    }
                elif method == "ping":
                    response = {
                        "jsonrpc": "2.0",
                        "id": request["id"],
                        "result": {"nonce": request["params"].get("nonce")},
                    }
                else:
                    continue
                writer.write(json.dumps(response).encode() + b"\n")
                await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        address = server.sockets[0].getsockname()

        async def notification(method: str, params: dict[str, object]) -> None:
            notifications.append((method, params))

        async def exited(code: int | None) -> None:
            exits.append(code)

        client = BridgeClient(
            endpoint=BridgeEndpoint(
                host="127.0.0.1",
                port=address[1],
                token="test-token",
                pid=1,
                path=tmp_path / "endpoint.json",
            ),
            connector_id="connector-test",
            client_version="test",
            startup_timeout=2,
            request_timeout=2,
            notification_handler=notification,
            exit_handler=exited,
        )
        try:
            initialized = await client.start()
            assert initialized["identity"]["runtime"] == "dsh"
            assert await client.request("ping", {"nonce": "n1"}) == {"nonce": "n1"}
            await asyncio.sleep(0)
            assert notifications[0][0] == "runtime.capabilities.update"
            assert saw_token is True
            await client.close()
            assert exits == []
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(run())


def test_bridge_client_observes_notification_handler_failure(tmp_path: Path) -> None:
    async def run() -> None:
        loop_errors: list[dict[str, object]] = []

        async def notification(_method: str, _params: dict[str, object]) -> None:
            raise ValueError("invalid notification")

        async def exited(_code: int | None) -> None:
            return None

        client = BridgeClient(
            endpoint=BridgeEndpoint(
                host="127.0.0.1",
                port=1,
                token="test-token",
                pid=1,
                path=tmp_path / "endpoint.json",
            ),
            connector_id="connector-test",
            client_version="test",
            startup_timeout=2,
            request_timeout=2,
            notification_handler=notification,
            exit_handler=exited,
        )
        loop = asyncio.get_running_loop()
        previous_handler = loop.get_exception_handler()
        loop.set_exception_handler(lambda _loop, context: loop_errors.append(context))
        try:
            client._dispatch_notification("timeline.item.upsert", {})
            await asyncio.sleep(0)
            await asyncio.sleep(0)
        finally:
            loop.set_exception_handler(previous_handler)

        assert client._notification_tasks == set()
        assert loop_errors == []

    asyncio.run(run())
