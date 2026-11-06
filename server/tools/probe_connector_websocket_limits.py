"""Real WebSocket receive-budget probes with controlled authentication, no DB.

Run from server: python -m tools.probe_connector_websocket_limits --output PATH
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import socket
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
import websockets
from agent_server.infra.websocket_limits import (
    CLIENT_WS_MAX_MESSAGE_BYTES,
    CONTROL_WS_MAX_MESSAGE_BYTES,
    ControlWebSocketProtocol,
    allow_large_control_messages,
)
from fastapi import FastAPI, WebSocket
from starlette.websockets import WebSocketDisconnect
from websockets.exceptions import ConnectionClosed, InvalidStatus

MIB = 1024 * 1024
AUTH = {"Authorization": "Bearer isolated-budget-probe"}
CAPABILITIES = {
    "X-AA-Control-Transport": "meshcall/1.0",
    "X-AA-Control-Fallback": "websocket/1.0",
}
CLIENT = "/api/v2/sessions/probe/ws"
BASE = "/api/v2/connector/ws"
MESH = "/api/v2/connector/mesh"
RELAY = "/api/v2/connector/terminals/probe/relay"


def create_probe_app(stats: dict) -> FastAPI:
    app = FastAPI()

    @app.websocket("/{path:path}")
    async def echo(ws: WebSocket, path: str):
        actual_path = "/" + path
        if actual_path in {BASE, MESH}:
            if ws.headers.get("authorization") != AUTH["Authorization"]:
                await ws.close(code=1008)
                return
            if actual_path == MESH or (
                ws.headers.get("x-aa-control-transport") == "meshcall/1.0"
                and ws.headers.get("x-aa-control-fallback") == "websocket/1.0"
            ):
                allow_large_control_messages(ws.scope)
        await ws.accept()
        try:
            while True:
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    return
                stats["delivered"] += 1
                data = message.get("bytes")
                if data is None:
                    data = message["text"].encode()
                await ws.send_json(
                    {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                )
        except WebSocketDisconnect:
            pass

    return app


@asynccontextmanager
async def serve(stats: dict, *, configured_limit: int = CLIENT_WS_MAX_MESSAGE_BYTES):
    class ObservedProtocol(ControlWebSocketProtocol):
        def handle_parser_exception(self) -> None:
            stats["rejections"].append(
                {
                    "path": self.scope["path"],
                    "error": type(self.conn.parser_exc).__name__,
                }
            )
            super().handle_parser_exception()

    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    listener.setblocking(False)
    port = listener.getsockname()[1]
    config = uvicorn.Config(
        create_probe_app(stats),
        host="127.0.0.1",
        port=port,
        ws=ObservedProtocol,
        ws_max_size=configured_limit,
        lifespan="off",
        log_level="critical",
        access_log=False,
        timeout_graceful_shutdown=2,
    )
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    await task
                    raise RuntimeError("budget probe server exited during startup")
                await asyncio.sleep(0.01)
        yield f"ws://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        try:
            async with asyncio.timeout(10):
                await asyncio.shield(task)
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            listener.close()


def connect(url, *, headers=None, compression=None):
    return websockets.connect(
        url,
        additional_headers=headers,
        proxy=None,
        compression=compression,
        max_size=MIB,
        close_timeout=2,
    )


async def exchange(ws, payload):
    pieces = payload if isinstance(payload, list) else [payload]
    digest, size = hashlib.sha256(), 0
    for piece in pieces:
        data = piece.encode() if isinstance(piece, str) else piece
        size += len(data)
        digest.update(data)
    await ws.send(payload)
    reply = json.loads(await ws.recv())
    assert reply == {"bytes": size, "sha256": digest.hexdigest()}, reply


async def run_probe() -> list[dict]:
    results = []
    stats = {"delivered": 0, "rejections": []}

    async def case(
        base, path, payload, *, accepted, label, headers=None, compression=None
    ):
        delivered, rejections = stats["delivered"], len(stats["rejections"])
        async with asyncio.timeout(15):
            async with connect(
                base + path, headers=headers, compression=compression
            ) as ws:
                try:
                    await exchange(ws, payload)
                except ConnectionClosed as error:
                    assert not accepted, (label, error)
                    # SansIO can reset TCP before the peer receives its close
                    # frame. Prove the parser rejected size, not an unrelated
                    # disconnect, and that the app never received the message.
                    assert any(
                        row == {"path": path, "error": "PayloadTooBig"}
                        for row in stats["rejections"][rejections:]
                    ), (label, error)
                    assert stats["delivered"] == delivered
                else:
                    assert accepted, label
        results.append({"scenario": label, "passed": True})

    async with serve(stats) as base:
        await case(
            base,
            CLIENT,
            b"x" * (16 * MIB),
            accepted=True,
            label="ordinary client accepts exactly 16 MiB",
        )
        await case(
            base,
            CLIENT,
            b"x" * (16 * MIB + 1),
            accepted=False,
            label="ordinary client rejects one byte over its budget",
        )
        await case(
            base,
            CLIENT,
            b"x" * (17 * MIB),
            accepted=False,
            headers=AUTH | CAPABILITIES,
            label="control capability headers cannot enlarge an ordinary client",
        )
        await case(
            base,
            BASE,
            b"x" * (16 * MIB),
            accepted=True,
            headers=AUTH,
            label="old Connector keeps its original receive range",
        )
        await case(
            base,
            BASE,
            b"x" * (16 * MIB + 1),
            accepted=False,
            headers=AUTH,
            label="old Connector does not acquire the new control budget",
        )
        for headers, label in (
            (
                AUTH | {"X-AA-Control-Fallback": "websocket/1.0"},
                "missing Mesh capability",
            ),
            (
                AUTH
                | {
                    "X-AA-Control-Transport": "meshcall/1.0",
                    "X-AA-Control-Fallback": "unknown",
                },
                "unknown fallback capability",
            ),
        ):
            await case(
                base,
                BASE,
                b"x" * (17 * MIB),
                accepted=False,
                headers=headers,
                label=label,
            )
        await case(
            base,
            RELAY,
            b"x" * (17 * MIB),
            accepted=False,
            headers=AUTH | CAPABILITIES,
            label="terminal relay keeps its original receive budget",
        )

        for path, headers, name in (
            (BASE, AUTH | CAPABILITIES, "fallback"),
            (MESH, AUTH, "mesh"),
        ):
            await case(
                base,
                path,
                b"x" * (17 * MIB),
                accepted=True,
                headers=headers,
                label=f"{name} upgrades before the first large message",
            )
            await case(
                base,
                path,
                b"x" * (64 * MIB),
                accepted=True,
                headers=headers,
                label=f"{name} accepts exactly 64 MiB",
            )
            await case(
                base,
                path,
                b"x" * (64 * MIB + 1),
                accepted=False,
                headers=headers,
                label=f"{name} rejects one byte over 64 MiB",
            )
            try:
                async with connect(base + path, headers=CAPABILITIES):
                    raise AssertionError("unauthenticated control socket accepted")
            except InvalidStatus as error:
                assert error.response.status_code == 403
            results.append(
                {
                    "scenario": f"{name} authentication precedes budget upgrade",
                    "passed": True,
                }
            )

        await case(
            base,
            CLIENT,
            [b"x" * (9 * MIB)] * 2,
            accepted=False,
            label="ordinary fragments share one cumulative message budget",
        )
        await case(
            base,
            BASE,
            [b"x" * (9 * MIB)] * 2,
            accepted=True,
            headers=AUTH | CAPABILITIES,
            label="control accepts a fragmented message over 16 MiB",
        )
        await case(
            base,
            BASE,
            [b"x" * (32 * MIB)] * 2,
            accepted=True,
            headers=AUTH | CAPABILITIES,
            label="control accepts fragmented messages exactly at its budget",
        )
        await case(
            base,
            BASE,
            [b"x" * (32 * MIB), b"x" * (32 * MIB + 1)],
            accepted=False,
            headers=AUTH | CAPABILITIES,
            label="control rejects cumulative fragments over 64 MiB",
        )
        await case(
            base,
            CLIENT,
            "界" * (5 * MIB),
            accepted=True,
            label="text budget counts UTF-8 bytes",
        )
        await case(
            base,
            CLIENT,
            "界" * (6 * MIB),
            accepted=False,
            label="text is rejected by bytes rather than character count",
        )
        await case(
            base,
            BASE,
            "界" * (6 * MIB),
            accepted=True,
            headers=AUTH | CAPABILITIES,
            label="control accepts Unicode text over the client byte limit",
        )
        await case(
            base,
            CLIENT,
            b"x" * (17 * MIB),
            accepted=False,
            compression="deflate",
            label="compressed ordinary messages are limited after decompression",
        )
        await case(
            base,
            MESH,
            b"x" * (17 * MIB),
            accepted=True,
            headers=AUTH,
            compression="deflate",
            label="compressed control message uses its upgraded budget",
        )
        await case(
            base,
            MESH,
            b"x" * (64 * MIB + 1),
            accepted=False,
            headers=AUTH,
            compression="deflate",
            label="compressed control cannot exceed its decompressed byte budget",
        )
        async with connect(base + BASE, headers=AUTH | CAPABILITIES) as control:
            await exchange(control, b"x" * (17 * MIB))
            await case(
                base,
                CLIENT,
                b"x" * (17 * MIB),
                accepted=False,
                label="a control connection does not enlarge concurrent ordinary connections",
            )
            await exchange(control, b"control-still-usable")
        await case(
            base,
            CLIENT,
            b"ordinary-still-usable",
            accepted=True,
            label="oversized connections do not poison subsequent normal connections",
        )

    async with serve(stats, configured_limit=CONTROL_WS_MAX_MESSAGE_BYTES) as base:
        await case(
            base,
            CLIENT,
            b"x" * (17 * MIB),
            accepted=False,
            label="custom backend keeps clients bounded even with an old global 64 MiB setting",
        )
        await case(
            base,
            MESH,
            b"x" * (17 * MIB),
            accepted=True,
            headers=AUTH,
            label="custom backend still enables authenticated control with that launcher setting",
        )
    return results


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    results = asyncio.run(run_probe())
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
