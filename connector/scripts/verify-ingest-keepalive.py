"""End-to-end check of the ingest keep-alive race against a throwaway uvicorn, on the real client stack.

Topology: the HTTP client -> a local TCP relay that delays server-to-client bytes by LATENCY
(standing in for the path to the Server) -> uvicorn with its default timeout_keep_alive=5 s.

Why it fails without the fix: uvicorn starts its 5 s idle timer when it finishes sending the
response; httpx starts its own 5 s pool timer LATENCY later, when the response is received.
A request written inside that gap goes to a connection the server has already closed while
the FIN is still in transit (a blocking sleep stands in for a busy event loop that has not
processed it yet): "RemoteProtocolError: Server disconnected without sending a response".

Matrix, 3 trials each:
  A. plain httpx client (5 s pool expiry), send() straight                -> fails
  B. plain httpx client with the connector pool expiry, send() straight   -> passes
  C. plain httpx client through ConnectorIngestClient._send_with_auth    -> passes (reopened once)
  D. the client the connector builds for its backend, _send_with_auth    -> passes

Run from connector/: uv run python scripts/verify-ingest-keepalive.py  (needs uvicorn).
Exit code 0 when every row behaves as stated. Nothing touches a real Server.
"""
from __future__ import annotations

import asyncio
import socket
import sys
import time

try:
    import uvicorn
except ImportError:
    print("SKIP: uvicorn is not installed in this environment")
    sys.exit(0)

import httpx

from connector.server.errors import ConnectorNetworkError
from connector.server.ingest import ConnectorIngestClient
from connector.server.network import KEEPALIVE_EXPIRY_SECONDS, NetworkEgress

LATENCY = 0.3
# Client-side idle: past the server close (5.0 - LATENCY), inside the plain 5 s pool expiry.
IDLE = 4.75
TRIALS = 3
SERVER_PORT = 0
RELAY_PORT = 0


async def app(scope, receive, send):
    more = True
    while more:
        message = await receive()
        more = message.get("more_body", False)
        if message["type"] == "http.disconnect":
            return
    body = b'{"accepted": 0, "rejected": []}'
    await send({
        "type": "http.response.start", "status": 200,
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
    })
    await send({"type": "http.response.body", "body": body})


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def relay(reader, writer):
    """Forward both ways, delaying what comes from the server (its FIN too)."""
    server_reader, server_writer = await asyncio.open_connection("127.0.0.1", SERVER_PORT)

    async def to_server():
        while data := await reader.read(65536):
            server_writer.write(data)
            await server_writer.drain()
        server_writer.close()

    async def to_client():
        while data := await server_reader.read(65536):
            await asyncio.sleep(LATENCY)
            writer.write(data)
            await writer.drain()
        await asyncio.sleep(LATENCY)
        writer.close()

    await asyncio.gather(to_server(), to_client())


async def once(client: httpx.AsyncClient, reopen: bool) -> str:
    url = f"http://127.0.0.1:{RELAY_PORT}/api/v2/connector/ingest"

    async def send(token: str) -> httpx.Response:
        return await client.post(url, json={"notifications": []}, headers={"Authorization": f"Bearer {token}"})

    await send("token")
    time.sleep(IDLE)  # noqa: ASYNC251 -- the point: a busy event loop that has not processed the FIN yet
    try:
        if reopen:
            ingest = ConnectorIngestClient("http://127.0.0.1", None, lambda: client, None)
            await ingest._send_with_auth(send, "token", size=0)
        else:
            await send("token")
        return "OK"
    except (httpx.RequestError, ConnectorNetworkError) as exc:
        return f"FAILED {type(exc).__name__}: {exc}"


async def row(label: str, make_client, reopen: bool, expected_to_fail: bool) -> bool:
    outcomes = []
    for _ in range(TRIALS):
        async with make_client() as client:
            outcomes.append(await once(client, reopen))
    failed = sum(outcome.startswith("FAILED") for outcome in outcomes)
    signature = next((outcome for outcome in outcomes if outcome.startswith("FAILED")), "")
    verdict = "PASS" if (failed > 0) == expected_to_fail else "FAIL"
    print(f"{verdict} {label}: {failed}/{TRIALS} failed {signature}", flush=True)
    return verdict == "PASS"


def connector_client() -> httpx.AsyncClient:
    return NetworkEgress("http://127.0.0.1", "direct").http_client(10)


async def main() -> bool:
    global SERVER_PORT, RELAY_PORT
    SERVER_PORT = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=SERVER_PORT, log_level="error", timeout_keep_alive=5))
    server_task = asyncio.create_task(server.serve())
    relay_server = await asyncio.start_server(relay, "127.0.0.1", 0)
    RELAY_PORT = relay_server.sockets[0].getsockname()[1]
    await asyncio.sleep(1.0)
    try:
        results = [
            await row("A. plain httpx client, send() straight (the race)",
                      lambda: httpx.AsyncClient(timeout=10, trust_env=False), False, True),
            await row(f"B. pool expiry {KEEPALIVE_EXPIRY_SECONDS} s, send() straight",
                      lambda: httpx.AsyncClient(
                          timeout=10, trust_env=False,
                          limits=httpx.Limits(keepalive_expiry=KEEPALIVE_EXPIRY_SECONDS),
                      ),
                      False, False),
            await row("C. plain httpx client through _send_with_auth (reopened once)",
                      lambda: httpx.AsyncClient(timeout=10, trust_env=False), True, False),
            await row("D. the connector backend client through _send_with_auth", connector_client, True, False),
        ]
        print("RESULT:", f"ALL PASS ({sum(results)}/{len(results)})" if all(results) else "FAIL")
        return all(results)
    finally:
        relay_server.close()
        server.should_exit = True
        await server_task


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(main()) else 1)
