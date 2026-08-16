from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from connector.logging import logger
from connector.server.auth import ConnectorAuthenticationError
from connector.server.errors import ConnectorNetworkError
from connector.server.urls import api_v2_url

# HTTP ingest owns explicit bulk sync and disconnected WebSocket fallback.
# History-bearing notifications such as `timeline.sync` must use ingest even
# when the WebSocket is connected; they can exceed the backend WebSocket frame
# limit and are not latency-sensitive. Live small notifications still travel
# over the connector WebSocket.
FLUSH_WINDOW_SECONDS = 0.02
FLUSH_MAX = 64

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
        self._notify_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def enqueue(self, method: str, params: dict[str, Any]) -> None:
        await self._notify_queue.put({"method": method, "params": params})

    async def ingest_notifications(self, notifications: list[dict[str, Any]]) -> None:
        """Send a batch synchronously, bypassing the flush queue."""
        if not notifications:
            return
        await self.post_batch(list(notifications))

    async def flush_loop(self) -> None:
        """Drain notification queue and POST in bounded batches.

        Errors are logged and the loop continues. Losing a notification is
        preferable to hanging the connector process.
        """
        while True:
            try:
                first = await self._notify_queue.get()
            except asyncio.CancelledError:
                return
            batch: list[dict[str, Any]] = [first]
            deadline = asyncio.get_event_loop().time() + FLUSH_WINDOW_SECONDS
            while len(batch) < FLUSH_MAX:
                remaining = deadline - asyncio.get_event_loop().time()
                if remaining <= 0:
                    break
                try:
                    item = await asyncio.wait_for(
                        self._notify_queue.get(), timeout=remaining
                    )
                except asyncio.TimeoutError:
                    break
                except asyncio.CancelledError:
                    try:
                        await self.post_batch(batch)
                    except Exception:  # noqa: BLE001
                        pass
                    return
                batch.append(item)
            try:
                await self.post_batch(batch)
            except ConnectorNetworkError as exc:
                logger.warning(
                    "connector ingest flush failed due to network error; dropped {} notifications error={}",
                    len(batch),
                    exc,
                )
            except Exception:  # noqa: BLE001
                logger.exception(
                    "connector ingest flush failed (dropped {} notifications)",
                    len(batch),
                )

    async def post_batch(self, notifications: list[dict[str, Any]]) -> None:
        if not notifications:
            return
        notifications = coalesce_timeline_item_upserts(notifications)
        if not notifications:
            return
        access_token = await self._access_token_provider(False)
        client = self._http_client_getter()
        owned = client is None
        if client is None:
            client = self._http_client_factory(60)
        try:
            try:
                response = await self._post_ingest_batch(
                    client, access_token, notifications
                )
            except httpx.RequestError as exc:
                raise ConnectorNetworkError(
                    f"backend ingest request failed: {exc}"
                ) from exc
            if getattr(response, "status_code", None) == 401:
                logger.warning(
                    "connector ingest token rejected; refreshing access token and retrying"
                )
                access_token = await self._access_token_provider(True)
                try:
                    response = await self._post_ingest_batch(
                        client, access_token, notifications
                    )
                except httpx.RequestError as exc:
                    raise ConnectorNetworkError(
                        f"backend ingest retry failed: {exc}"
                    ) from exc
                if getattr(response, "status_code", None) == 401:
                    raise ConnectorAuthenticationError(
                        "connector credential no longer valid"
                    )
            response.raise_for_status()
            _raise_for_rejected_notifications(response)
        finally:
            if owned:
                await client.aclose()

    async def _post_ingest_batch(
        self,
        client: httpx.AsyncClient,
        access_token: str,
        notifications: list[dict[str, Any]],
    ) -> httpx.Response:
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
