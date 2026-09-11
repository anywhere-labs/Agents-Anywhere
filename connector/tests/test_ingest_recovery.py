from __future__ import annotations

import asyncio

import httpx
import pytest

from connector.server.auth import ConnectorAuthenticationError
from connector.server.ingest import ConnectorIngestClient
from connector.server.rpc import ConnectorRpcChannel


def test_network_failure_and_server_503_keep_fifo_for_recovery():
    async def run():
        attempts = []
        delivered = asyncio.Event()

        async def token(force):
            return "token"

        async def transport(request):
            import json
            batch = json.loads(request.content)["notifications"]
            attempts.append(batch)
            if len(attempts) == 1:
                raise httpx.ConnectError("offline", request=request)
            if len(attempts) == 2:
                return httpx.Response(503)
            delivered.set()
            return httpx.Response(200, json={"accepted": len(batch), "rejected": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = ConnectorIngestClient("https://server.test", token, lambda: http, lambda timeout: http)
            ingest._retry_delay = 0.001
            await ingest.enqueue("session.state.updated", {"status": "running"})
            await ingest.enqueue("session.state.updated", {"status": "idle"})
            task = asyncio.create_task(ingest.flush_loop())
            await asyncio.wait_for(delivered.wait(), 1)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert attempts[0] == attempts[1] == attempts[2]
            assert [row["params"]["status"] for row in attempts[2]] == ["running", "idle"]
            assert not ingest.has_pending

    asyncio.run(run())


def test_cancelled_http_batch_survives_flush_worker_restart():
    async def run():
        started = asyncio.Event()
        delivered = asyncio.Event()
        calls = []

        async def token(force):
            return "token"

        async def transport(request):
            calls.append(request.content)
            if len(calls) == 1:
                started.set()
                await asyncio.Event().wait()
            delivered.set()
            return httpx.Response(200, json={"accepted": 1, "rejected": []})

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as http:
            ingest = ConnectorIngestClient("https://server.test", token, lambda: http, lambda timeout: http)
            await ingest.enqueue("timeline.sync", {"sessionId": "session", "items": []})
            task = asyncio.create_task(ingest.flush_loop())
            await started.wait()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert ingest.has_pending
            task = asyncio.create_task(ingest.flush_loop())
            await asyncio.wait_for(delivered.wait(), 1)
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert calls[0] == calls[1]

    asyncio.run(run())


def test_revoked_credentials_stop_retry_and_reject_new_admission():
    async def run():
        async def token(force):
            raise ConnectorAuthenticationError("revoked")

        ingest = ConnectorIngestClient("https://server.test", token, lambda: None, lambda timeout: None)
        await ingest.enqueue("connector.heartbeat", {})
        with pytest.raises(ConnectorAuthenticationError):
            await asyncio.wait_for(ingest.flush_loop(), 1)
        with pytest.raises(ConnectorAuthenticationError):
            await ingest.enqueue("connector.heartbeat", {})

    asyncio.run(run())


def test_old_rpc_completion_cannot_reply_on_replacement_socket():
    async def run():
        class Socket:
            def __init__(self):
                self.frames = []

            async def send(self, payload):
                self.frames.append(payload)

        entered, release = asyncio.Event(), asyncio.Event()
        channel = ConnectorRpcChannel()
        old, new = Socket(), Socket()
        channel.set_connection(old)

        async def dispatch(method, params):
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                # Some runtime operations finish cleanup despite cancellation.
                await release.wait()
            return {"status": "stopped"}

        channel.start_request({"type": "request", "id": "old", "method": "runtime.stop"}, dispatch)
        await entered.wait()
        old_tasks = list(channel._request_tasks)
        channel.set_connection(new)
        release.set()
        await asyncio.gather(*old_tasks)
        assert not old.frames and not new.frames
        await channel.close_connection()

    asyncio.run(run())
