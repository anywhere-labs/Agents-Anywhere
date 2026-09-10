import asyncio

import httpx
import pytest
from dsh_probe_transport import IngestTransport


def test_client_disconnect_does_not_cancel_backend_ingestion_and_close_drains_it():
    async def exercise():
        entered, release = asyncio.Event(), asyncio.Event()
        committed = []
        cancelled = []

        async def app(scope, receive, send):
            entered.set()
            try:
                await release.wait()
                committed.append(True)
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": b'{"rejected": []}'})
            except asyncio.CancelledError:
                cancelled.append(True)
                raise

        transport = IngestTransport(app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            request = asyncio.create_task(client.post("/api/v2/connector/ingest", json={
                "notifications": [{"method": "timeline.sync", "params": {}}],
            }))
            await asyncio.wait_for(entered.wait(), 1)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            try:
                assert not cancelled, "client disconnect must not cancel the backend transaction"
                closing = asyncio.create_task(client.aclose())
                await asyncio.sleep(0)
                assert not closing.done(), "close must wait for accepted backend requests"
                release.set()
                await asyncio.wait_for(closing, 1)
                assert committed == [True]
                assert len(transport.notifications) == 1
            finally:
                release.set()

    asyncio.run(exercise())
