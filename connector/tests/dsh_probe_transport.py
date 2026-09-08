"""In-process HTTP carrier for the DSH integration probes."""

import asyncio
import json

import httpx


class IngestTransport(httpx.AsyncBaseTransport):
    def __init__(self, app) -> None:
        self.inner = httpx.ASGITransport(app)
        self.notifications: list[dict] = []
        self.lose_snapshot_reply = False
        self.lost = False
        self.pending: set[asyncio.Task[httpx.Response]] = set()

    async def handle_async_request(self, request):
        # A real HTTP disconnect does not cancel the server's request task.
        # Keep ASGI ingestion alive when the probe stops its Connector mid-request,
        # and drain it before disposing the test database.
        task = asyncio.create_task(self.ingest(request))
        self.pending.add(task)
        try:
            response = await asyncio.shield(task)
        except asyncio.CancelledError:
            raise
        except BaseException:
            self.pending.discard(task)
            raise
        else:
            self.pending.discard(task)
        notices = json.loads(request.content)["notifications"]
        if self.lose_snapshot_reply and any(n["method"] == "timeline.sync" for n in notices):
            self.lose_snapshot_reply = False
            self.lost = True
            raise httpx.ReadError("Simulated lost HTTP reply after ingestion", request=request)
        return response

    async def ingest(self, request):
        assert request.url.path == "/api/v2/connector/ingest"
        notices = json.loads(request.content)["notifications"]
        response = await self.inner.handle_async_request(request)
        await response.aread()
        assert response.status_code == 200, response.text
        assert not response.json().get("rejected"), response.text
        self.notifications.extend(notices)
        return response

    async def aclose(self):
        results = await asyncio.gather(*self.pending, return_exceptions=True)
        self.pending.clear()
        await self.inner.aclose()
        for result in results:
            if isinstance(result, BaseException):
                raise result
