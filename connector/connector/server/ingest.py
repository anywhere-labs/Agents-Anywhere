from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable, Iterable
from typing import Any, BinaryIO

import httpx

from connector.logging import logger
from connector.runtime_protocol.host import UploadProgress
from connector.server.auth import ConnectorAuthenticationError
from connector.server.errors import ConnectorNetworkError
from connector.server.snapshot_body import body_digest, snapshot_body
from connector.server.urls import api_v2_url

# HTTP ingest owns explicit bulk sync and disconnected WebSocket fallback.
# History-bearing notifications such as `timeline.sync` must use ingest even
# when the WebSocket is connected; they can exceed the backend WebSocket frame
# limit and are not latency-sensitive. Live small notifications still travel
# over the connector WebSocket.
FLUSH_WINDOW_SECONDS = 0.02
FLUSH_MAX = 64
UPLOAD_CHUNK_BYTES = 64 * 1024

AccessTokenProvider = Callable[[bool], Awaitable[str]]
HttpClientGetter = Callable[[], httpx.AsyncClient | None]
HttpClientFactory = Callable[[httpx.Timeout | float], httpx.AsyncClient]


class ConnectorIngestRejectedError(RuntimeError):
    """The backend accepted the HTTP request but rejected notifications inside it."""


class ConnectorIngestClient:
    def __init__(
        self,
        server_url: str,
        access_token_provider: AccessTokenProvider,
        http_client_getter: HttpClientGetter,
        http_client_factory: HttpClientFactory,
    ) -> None:
        self._server_url = server_url
        self._access_token_provider = access_token_provider
        self._http_client_getter = http_client_getter
        self._http_client_factory = http_client_factory
        self._notify_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1024)
        self._inflight: list[dict[str, Any]] = []
        self._retry_delay = 1.0
        self._closed: Exception | None = None
        self._post_lock = asyncio.Lock()
        self._available = asyncio.Event()
        self._posting = False

    @property
    def has_pending(self) -> bool:
        return self._posting or bool(self._inflight) or not self._notify_queue.empty()

    def close(self, error: Exception | None = None) -> None:
        self._closed = error or RuntimeError("connector ingest is closed")
        # Wake blocked producers. They check _closed again after admission.
        while not self._notify_queue.empty():
            self._notify_queue.get_nowait()


    async def enqueue(self, method: str, params: dict[str, Any]) -> None:
        if self._closed is not None:
            raise self._closed
        await self._notify_queue.put({"method": method, "params": params})
        self._available.set()
        if self._closed is not None:
            self.close(self._closed)
            raise self._closed

    async def ingest_notifications(self, notifications: list[dict[str, Any]], *, on_progress: UploadProgress | None = None) -> None:
        """Send a batch synchronously, bypassing the flush queue."""
        if not notifications:
            return
        await self.post_batch(list(notifications), on_progress=on_progress)

    async def ingest_snapshot(
        self, runtime: str, runtime_id: str, session_id: str,
        meta: dict[str, Any], items: Iterable[dict[str, Any]], through_seq: int, *, on_progress: UploadProgress | None = None,
    ) -> None:
        task = asyncio.create_task(asyncio.to_thread(snapshot_body, runtime, runtime_id, session_id, meta, items, through_seq))
        try:
            body = await asyncio.shield(task)
        except asyncio.CancelledError:
            (await task).close()
            raise
        try:
            async with self._post_lock:
                self._posting = True
                try:
                    await self._drain_pending(on_progress)
                    client = self._http_client_getter()
                    owned = client is None
                    if client is None:
                        client = self._http_client_factory(60)
                    try:
                        await self._upload_snapshot(client, body, session_id, runtime_id, through_seq, on_progress)
                    finally:
                        if owned:
                            await client.aclose()
                finally:
                    self._posting = False
                    if not self.has_pending:
                        self._available.clear()
        finally:
            body.close()

    async def _upload_snapshot(self, client, body: BinaryIO, session_id, runtime_id, through_seq, on_progress):
        digest_task = asyncio.create_task(asyncio.to_thread(body_digest, body))
        try:
            upload_id, size = await asyncio.shield(digest_task)
        except asyncio.CancelledError:
            await digest_task
            raise
        manifest = {"uploadId": upload_id, "sessionId": session_id, "runtimeId": runtime_id,
                    "throughSeq": through_seq, "totalBytes": size}
        root = api_v2_url(self._server_url, "/connector/ingest/uploads")

        async def request(method, url, *, payload=None, chunk=None):
            async def send(token):
                if chunk is None:
                    return await client.request(method, url, headers={"Authorization": f"Bearer {token}"}, json=payload, timeout=60)
                async def stream():
                    for offset in range(0, len(chunk), UPLOAD_CHUNK_BYTES):
                        part = chunk[offset:offset + UPLOAD_CHUNK_BYTES]
                        yield part
                        if on_progress is not None:
                            await on_progress(len(part))
                return await client.request(method, url, headers={"Authorization": f"Bearer {token}",
                    "Content-Type": "application/octet-stream", "Content-Length": str(len(chunk))}, content=stream(), timeout=60)
            return await self._send_with_auth(send, await self._access_token_provider(False))

        state = (await request("POST", root, payload=manifest)).json()
        if type(state.get("committed")) is not bool:
            raise ValueError("Invalid snapshot commit status")
        if state["committed"]:
            return
        chunk_bytes = state["chunkBytes"]
        if chunk_bytes != 262_144:
            raise ValueError("Unsupported snapshot chunk size")
        received = set(state["receivedChunks"])
        total_chunks = (size + chunk_bytes - 1) // chunk_bytes
        if any(type(i) is not int or not 0 <= i < total_chunks for i in received):
            raise ValueError("Invalid snapshot upload status")
        for index in range(total_chunks):
            if index in received:
                continue
            body.seek(index * chunk_bytes)
            chunk = body.read(chunk_bytes)
            await request("PUT", f"{root}/{upload_id}/chunks/{index}", chunk=chunk)
        result = (await request("POST", f"{root}/{upload_id}/commit")).json()
        if result.get("committed") is not True:
            raise ConnectorIngestRejectedError("Snapshot was not committed")

    async def flush_loop(self) -> None:
        """Keep a failed batch at the head; cancellation leaves it recoverable.

        Delivery is at least once after an ambiguous HTTP failure. State/item
        replacements retain their protocol versions; no synthetic revision is
        introduced by a retry. Authentication and permanent rejections do not
        enter the transient-error retry loop.
        """
        attempt = 0
        while True:
            await self._available.wait()
            if not self._inflight:
                await asyncio.sleep(FLUSH_WINDOW_SECONDS)
            try:
                async with self._post_lock:
                    self._posting = True
                    try:
                        self._collect_pending()
                        await self._post_batch(self._inflight)
                        self._inflight = []
                        if self._notify_queue.empty():
                            self._available.clear()
                    finally:
                        self._posting = False
            except ConnectorAuthenticationError as exc:
                self.close(exc)
                raise
            except ConnectorNetworkError as exc:
                attempt += 1
                if attempt == 1 or attempt % 10 == 0:
                    logger.warning("connector ingest deferred notifications={} attempt={} error={}", len(self._inflight), attempt, exc)
                await asyncio.sleep(min(30.0, self._retry_delay * 2 ** min(attempt - 1, 5)))
                continue
            except (ConnectorIngestRejectedError, httpx.HTTPStatusError) as exc:
                logger.warning("connector ingest permanently rejected notifications={} error={}", len(self._inflight), exc)
            self._inflight = []
            attempt = 0

    def _collect_pending(self) -> None:
        if self._inflight:
            return
        while len(self._inflight) < FLUSH_MAX and not self._notify_queue.empty():
            self._inflight.append(self._notify_queue.get_nowait())

    async def post_batch(self, notifications: list[dict[str, Any]], *, on_progress: UploadProgress | None = None) -> None:
        async with self._post_lock:
            self._posting = True
            try:
                await self._drain_pending(on_progress)
                await self._post_batch(notifications, on_progress=on_progress)
            finally:
                self._posting = False
                if not self.has_pending:
                    self._available.clear()

    async def _drain_pending(self, on_progress):
        # Preserve FIFO ahead of a synchronous snapshot; only drain work queued at admission.
        remaining = len(self._inflight) + self._notify_queue.qsize()
        while remaining:
            self._collect_pending()
            await self._post_batch(self._inflight, on_progress=on_progress)
            remaining = max(0, remaining - len(self._inflight))
            self._inflight = []

    async def _post_batch(self, notifications: list[dict[str, Any]], *, on_progress: UploadProgress | None = None) -> None:
        if not notifications:
            return
        notifications = coalesce_timeline_item_upserts(notifications)
        if not notifications:
            return
        token = await self._access_token_provider(False)
        client = self._http_client_getter()
        owned = client is None
        if client is None:
            client = self._http_client_factory(60)
        try:
            await self._send_with_auth(lambda token: self._post_ingest_batch(client, token, notifications, on_progress=on_progress), token)
        finally:
            if owned:
                await client.aclose()

    async def _send_with_auth(self, send, token):
        try:
            response = await send(token)
            if getattr(response, "status_code", None) == 401:
                token = await self._access_token_provider(True)
                response = await send(token)
                if getattr(response, "status_code", None) == 401:
                    raise ConnectorAuthenticationError("connector credential no longer valid")
        except httpx.RequestError as exc:
            raise ConnectorNetworkError(f"backend ingest request failed: {exc}") from exc
        status = getattr(response, "status_code", 200)
        if status in {408, 429} or status >= 500:
            raise ConnectorNetworkError(f"backend ingest temporarily unavailable: HTTP {status}")
        response.raise_for_status()
        _raise_for_rejected_notifications(response)
        return response

    async def _post_ingest_batch(
        self,
        client: httpx.AsyncClient,
        access_token: str,
        notifications: list[dict[str, Any]],
        *, on_progress: UploadProgress | None = None,
    ) -> httpx.Response:
        if on_progress is not None:
            encoded = json.dumps({"notifications": notifications}, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")

            async def body():
                for offset in range(0, len(encoded), UPLOAD_CHUNK_BYTES):
                    chunk = encoded[offset:offset + UPLOAD_CHUNK_BYTES]
                    yield chunk
                    # Resumption means the transport accepted the previous write.
                    # This is liveness only; cloud acceptance still gates ACK/save.
                    await on_progress(len(chunk))

            return await client.post(
                api_v2_url(self._server_url, "/connector/ingest"),
                headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json", "Content-Length": str(len(encoded))},
                content=body(),
                timeout=60,
            )
        return await client.post(
            api_v2_url(self._server_url, "/connector/ingest"),
            headers={"Authorization": f"Bearer {access_token}"},
            json={"notifications": notifications},
            timeout=60,
        )


def _raise_for_rejected_notifications(response: httpx.Response) -> None:
    json_reader = getattr(response, "json", None)
    if not callable(json_reader):
        return
    try:
        payload = json_reader()
    except ValueError:
        return
    if not isinstance(payload, dict):
        return
    rejected = payload.get("rejected")
    if not isinstance(rejected, list) or not rejected:
        return
    first = rejected[0] if isinstance(rejected[0], dict) else {}
    method = first.get("method") if isinstance(first.get("method"), str) else "unknown"
    code = (
        first.get("code")
        if isinstance(first.get("code"), str)
        else "notification_rejected"
    )
    message = (
        first.get("message")
        if isinstance(first.get("message"), str)
        else "backend rejected connector notification"
    )
    raise ConnectorIngestRejectedError(
        f"backend ingest rejected {len(rejected)} notification(s); "
        f"first method={method} code={code}: {message}"
    )


def coalesce_timeline_item_upserts(
    notifications: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Keep only the newest upsert per timeline item inside one outbound batch."""
    latest_index_by_key: dict[tuple[str, str], int] = {}
    dropped: set[int] = set()
    for index, notification in enumerate(notifications):
        if notification.get("method") != "timeline.itemUpsert":
            continue
        params = notification.get("params")
        if not isinstance(params, dict):
            continue
        session_id = params.get("sessionId")
        item = params.get("item")
        item_id = item.get("id") if isinstance(item, dict) else None
        if not isinstance(session_id, str) or not isinstance(item_id, str):
            continue
        key = (session_id, item_id)
        previous = latest_index_by_key.get(key)
        if previous is not None:
            dropped.add(previous)
        latest_index_by_key[key] = index
    if not dropped:
        return notifications
    return [
        notification
        for index, notification in enumerate(notifications)
        if index not in dropped
    ]
