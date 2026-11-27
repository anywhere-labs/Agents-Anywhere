from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from typing import Any

import httpx

from connector.core.unicode import UTF8_REPLACE_LONE_SURROGATES
from connector.logging import logger
from connector.runtime_protocol.host import UploadProgress
from connector.server.auth import ConnectorAuthenticationError
from connector.server.errors import ConnectorIngestClosedError, ConnectorNetworkError
from connector.server.snapshot_body import (
    SNAPSHOT_LEGACY_PAGE_BYTES,
    SNAPSHOT_MIN_PAGE_BYTES,
    SNAPSHOT_PAGE_BYTES,
    EncodedSnapshot,
    encode_snapshot,
)
from connector.server.urls import api_v2_url

# HTTP ingest owns explicit bulk sync and disconnected WebSocket fallback.
# History-bearing notifications such as `timeline.sync` must use ingest even
# when the WebSocket is connected; they can exceed the backend WebSocket frame
# limit and are not latency-sensitive. Live small notifications still travel
# over the connector WebSocket.
FLUSH_WINDOW_SECONDS = 0.02
FLUSH_MAX = 64
UPLOAD_CHUNK_BYTES = 64 * 1024
# A snapshot page that fails for a transient reason is retried this often, with
# a doubling backoff. A Server without ranged pages holds only part of the
# history from the first page of a paged snapshot until the last page lands.
SNAPSHOT_PAGE_RETRIES = 4
SNAPSHOT_PAGE_RETRY_BACKOFF_SECONDS = 0.5
# From the moment a page's body stalls for the whole write timeout, snapshot
# uploads cool down this long before the next attempt, while the stalled page
# itself is cut smaller and sent again from its own start. A stall says the
# path is weak right now, not that every session must wait ten minutes: the
# cool-down only keeps the other snapshots off the path meanwhile, and one
# stalled page must not starve the small snapshots of all the other sessions,
# which would pass in a second or two (seen on a weak link: 19 of 20 snapshots
# were refused unsent behind one 45 MiB page). The cool-down doubles with each
# upload that stalls (stalls while a cool-down is on are one slow path) and is
# reset by one that gets through, so a path that stalls again and again with
# nothing getting through still backs off, up to ten minutes. A caller that
# asks during the cool-down meets ConnectorIngestDeferredError, which says how
# long it still is: asking again sooner cannot help, and a caller that retries
# at its own pace stays busy for the whole cool-down. A page given up after its
# stalls leaves the timeline held back longer by every caller that uploads it
# here and knows the timeline (the DSH sync relay, the ACP queue and the runtime
# sync of polling runtimes), each with a backoff of its own on top of this
# cool-down. The cool-down is no verdict on the page: its capture goes on at a
# smaller size, and a page of it that gets through ends the wait, wherever in
# the capture that is; its next stall counts as a first one. Uploads through
# the batch path see no flag and keep their own retries.
SNAPSHOT_STALL_WAIT_SECONDS = 60.0
SNAPSHOT_STALL_WAIT_MAX_SECONDS = 600.0
# A stalled page is cut this often before it is given up: to the legacy size
# first, then halved, never below the floor. A stall says nothing about how far
# the page got, and a page given up at once lost every write the path had
# accepted (seen on a weak link: 900-980 s of them, on pages of 45 MiB). The
# Server applies a page only once its whole body arrived, so a page that
# stalled never landed and goes out again from its own start; the pages it
# accepted before are not sent again.
SNAPSHOT_STALL_SHRINKS = 3
# The Server checks the bearer token only once the whole body of a page has
# arrived, so the token must outlive the page: a page whose body takes longer
# than the token's life is answered 401 after all that time, and sent again at
# the same size it can only fail the same way. A first 401 whose send ran this
# long is therefore not answered by a resend: the page is cut smaller, as after
# a stall, out of the same budget. The rule fires only when a 401 really came
# after ten minutes of body; a page that needs ten minutes should be cut
# whatever the token's life is, and the one false case (a credential revoked
# during such a body) only costs a page sent smaller. A shorter 401 is a stale
# token, as ever: one resend with a forced token. And a page above the legacy
# size starts with a forced token, since a reused one may have a minute left.
# The rule relies on the Server's token life (DEFAULT_EXPIRES_IN, 900 s) being
# longer than this plus the reuse skew: were it shorter, the full-size resend
# would return for pages that need most of the life, not a failure.
SNAPSHOT_TOKEN_OUTLIVED_SECONDS = 600.0
# A synchronous batch (for example one DSH sync batch the plugin waits on) that
# fails for a transient reason is retried this often before the caller sees the
# error. Delivery is at least once, as in the background flush loop; without a
# retry one dropped connection fails the whole DSH feed and forces a resync.
SYNC_BATCH_RETRIES = 3
SYNC_BATCH_RETRY_BACKOFF_SECONDS = 1.0
# Upload timeouts. The read timeout has to outlast the upload itself: a local
# proxy accepts the whole body at once and forwards it at its own pace, so the
# client finishes writing and starts waiting for an answer that cannot arrive
# until the proxy is done. It therefore grows with the body, assuming the slowest
# link worth waiting for. Writes and connects still fail on a real stall. A link
# slower than that would time out at the same point on every retry, so each
# retry after a read timeout doubles the read timeout: the retries of a snapshot
# page then wait for links down to a sixteenth of it.
UPLOAD_CONNECT_SECONDS = 15
UPLOAD_STALL_SECONDS = 60
UPLOAD_SLOWEST_BYTES_PER_SECOND = 64 * 1024

AccessTokenProvider = Callable[[bool], Awaitable[str]]
HttpClientGetter = Callable[[], httpx.AsyncClient | None]
HttpClientFactory = Callable[[httpx.Timeout | float], httpx.AsyncClient]


class ConnectorIngestRejectedError(RuntimeError):
    """The backend accepted the HTTP request but rejected notifications inside it."""


class ConnectorIngestRetryableError(ConnectorNetworkError):
    """The backend rejected notifications that are safe to retry."""


class ConnectorIngestDeferredError(ConnectorNetworkError):
    """A snapshot upload did not land: one stalled and the cool-down is not over.

    The cool-down is the same for every snapshot of the client. `retry_in` is
    how many seconds of it are left, so that a caller can wait exactly that
    long instead of asking again. It is still a network failure for a caller
    that does not look: the snapshot did not land (with `stalled`, part of its
    body may have reached the backend before the stall gave it up).

    `stalled` is True only when this caller's own upload body stalled and was
    given up, a page after its cuts (SNAPSHOT_STALL_SHRINKS) or a batch at
    once: its page was too much for the path, which the cool-down's ending
    says nothing about; or when its page was answered 401 after a body that
    outlived its token and could not be cut smaller (`outlived`: the body was
    paid in full, nothing stalled, and `page` is None). Every caller that
    uploads through ingest_snapshot then
    holds the timeline back by a backoff of its own, longer than `retry_in`. It is
    False when nothing
    was sent because the cool-down was already on: such a caller waits `retry_in`.

    `page` says how far the stalled page got (`_PageSend`), for a caller that
    wants to know what the stall cost. It is None when nothing was sent or the
    stalled body was a notification batch.
    """

    def __init__(
        self, retry_in: float, stalled: bool = False, *, page: _PageSend | None = None, outlived: bool = False,
    ) -> None:
        if outlived:
            stalled_body = "its page was answered 401 after a body that outlived its token, cannot be cut smaller, and"
        else:
            stalled_body = f"its page stalled ({page}) and" if page is not None else "the last one stalled and"
        super().__init__(
            f"snapshot upload deferred for {retry_in:.0f}s: {stalled_body} "
            "the path cannot carry bulk traffic right now"
        )
        self.retry_in = max(retry_in, 0.0)
        self.stalled = stalled or outlived
        self.page = page


class ConnectorPageOutlivedTokenError(ConnectorNetworkError):
    """A page was answered 401 after a body that ran past its token's life.

    Raised instead of a resend (SNAPSHOT_TOKEN_OUTLIVED_SECONDS): the body was
    paid for in full and the same size could only fail the same way.
    _post_snapshot_pages cuts the page as after a stall.
    """


class _PageSend:
    """How far the sending of one page got, to report a stall by what it cost.

    A give-up says only that the transport took no chunk for a whole write
    timeout, not how much of the page it took before: a page given up after
    many accepted writes lost all of them. `written` does say it. The body
    stream counts each chunk once the transport resumes it for the next, which
    is when it has taken that chunk, so the chunk a stall hits is not in it.
    `seconds` is how long the send took once the transport failed it, and
    `rate` the average in bytes per second.
    """

    def __init__(self, total: int) -> None:
        self.total = total
        self.written = 0
        self.started = time.monotonic()
        self.seconds = 0.0

    def failed(self) -> None:
        self.seconds = time.monotonic() - self.started

    @property
    def rate(self) -> float:
        return self.written / self.seconds if self.seconds else 0.0

    def __str__(self) -> str:
        return f"{self.written} of {self.total} bytes written at {self.rate / 1024:.1f} KiB/s over {self.seconds:.0f}s"


def _rejection_is_retryable(rejected: list[Any]) -> bool:
    """Only retry when every rejected notification is explicitly retryable.

    A mixed batch can contain a permanent validation failure; retrying it would
    never succeed and would hide the actual error behind a network failure.
    """

    return bool(rejected) and all(
        isinstance(item, dict) and item.get("retryable") is True
        for item in rejected
    )


class ConnectorIngestClient:
    def __init__(
        self,
        server_url: str,
        access_token_provider: AccessTokenProvider,
        http_client_getter: HttpClientGetter,
        http_client_factory: HttpClientFactory,
        *,
        snapshot_page_bytes: int = SNAPSHOT_PAGE_BYTES,
    ) -> None:
        self._server_url = server_url
        self._snapshot_page_bytes = snapshot_page_bytes
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
        self._snapshot_stalls = 0
        self._snapshot_retry_at = 0.0

    @property
    def has_pending(self) -> bool:
        return self._posting or bool(self._inflight) or not self._notify_queue.empty()

    def close(self, error: Exception | None = None) -> None:
        self._closed = error or ConnectorIngestClosedError("connector ingest is closed")
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
        meta: dict[str, Any], items: Iterable[dict[str, Any]], *, on_progress: UploadProgress | None = None,
        ordered: bool = True, complete: bool = True, trailing: Iterable[dict[str, Any]] = (),
    ) -> None:
        """Upload one snapshot; returns once every page was accepted.

        A ``complete`` snapshot replaces the timeline with its first page; a
        partial one only adds items. ``trailing`` notifications follow the last
        item in the same request as it.

        An ordered snapshot lands after the notifications already queued and
        holds later ones back until it is done. A caller that orders its own
        deliveries (the DSH sync relay) passes ``ordered=False``: a long upload
        then neither waits for the shared queue nor stalls it, and live
        notifications keep using the WebSocket meanwhile.

        A page whose body stalls for the whole write timeout is cut smaller
        and sent again from its own start, up to SNAPSHOT_STALL_SHRINKS times:
        for as long as a page is kept up at a size the path cannot carry, the
        backend WebSocket's keepalive starves and the Server drops the
        connection. From the stall on, snapshot uploads cool down, so every
        other session waits meanwhile; an upload that gets through ends the
        wait, or a page of one that stalled. A page given up after its cuts
        raises ConnectorIngestDeferredError with `stalled`, and the caller that
        knows the timeline holds it back longer still, see ConnectorIngestDeferredError.
        A caller that asks during the cool-down meets ConnectorIngestDeferredError
        before anything is sent.
        """
        wait = self.snapshot_wait()
        if wait > 0:
            raise ConnectorIngestDeferredError(wait)
        task = asyncio.create_task(asyncio.to_thread(
            encode_snapshot, runtime, runtime_id, session_id, meta, items, complete=complete, trailing=list(trailing),
        ))
        try:
            snapshot = await asyncio.shield(task)
        except asyncio.CancelledError:
            (await task).close()
            raise
        try:
            if not ordered:
                await self._upload_snapshot(snapshot, on_progress)
            else:
                async with self._post_lock:
                    self._posting = True
                    try:
                        # This one could not know: a wait may have begun while it
                        # queued for the lock behind another upload.
                        wait = self.snapshot_wait()
                        if wait > 0:
                            raise ConnectorIngestDeferredError(wait)
                        await self._drain_pending(on_progress)
                        await self._upload_snapshot(snapshot, on_progress)
                    finally:
                        self._posting = False
                        if not self.has_pending:
                            self._available.clear()
            self._reset_snapshot_wait()
        except ConnectorIngestDeferredError:
            # A page that stalled was deferred where it stalled, and re-paged as far as it could be.
            raise
        except ConnectorNetworkError as exc:
            if _body_stalled(exc):
                self._defer_snapshots(exc)
                raise self._deferred(exc)
            raise
        finally:
            snapshot.close()

    def snapshot_wait(self) -> float:
        """How much longer snapshot uploads are deferred; 0 when they are not."""
        return max(0.0, self._snapshot_retry_at - time.monotonic())

    def _reset_snapshot_wait(self) -> None:
        # An upload that got through was admitted before the wait began, so the
        # path carries bulk again.
        self._snapshot_stalls = 0
        self._snapshot_retry_at = 0.0

    def _defer_snapshots(self, error: Exception) -> None:
        # Uploads admitted before a wait began may stall while it is on: one slow path, one wait.
        if time.monotonic() >= self._snapshot_retry_at:
            self._snapshot_stalls += 1
        delay = _snapshot_stall_wait(self._snapshot_stalls)
        self._snapshot_retry_at = time.monotonic() + delay
        # A stalled batch sent ahead of an ordered snapshot is given up here as well:
        # the path cannot carry that either. A page says how far it got.
        page = _page_send(error)
        logger.warning(
            "an upload body stalled and was given up; snapshot uploads wait {:.0f}s stalls={}{} error={}",
            delay, self._snapshot_stalls, f" page {page}" if page is not None else "", error,
        )

    def _deferred(self, error: ConnectorNetworkError) -> ConnectorIngestDeferredError:
        # The upload that found the stall is told what every later one is, and
        # that the stall was its own: it did not land, and nothing will for a while.
        # The transport error stays its cause, as for every failed upload;
        # the wrapper stays as its context.
        deferred = ConnectorIngestDeferredError(
            self.snapshot_wait(), stalled=True, page=_page_send(error), outlived=_outlived_token(error),
        )
        deferred.__cause__ = error.__cause__
        return deferred

    async def _upload_snapshot(self, snapshot: EncodedSnapshot, on_progress: UploadProgress | None) -> None:
        client = self._http_client_getter()
        owned = client is None
        if client is None:
            client = self._http_client_factory(60)
        try:
            await self._post_snapshot_pages(client, snapshot, on_progress)
        finally:
            if owned:
                await client.aclose()

    async def _post_snapshot_pages(self, client, snapshot: EncodedSnapshot, on_progress: UploadProgress | None) -> None:
        # A snapshot that fits one page replaces the timeline atomically. Each
        # page of a paged one replaces only the orderSeq range it covers. A
        # Server that predates ranges replaces the timeline with the first page
        # and appends the rest instead, so it holds a partial history from the
        # first acceptance until the last page lands; pages therefore go out
        # back to back and the first is never sent again once accepted (on such
        # a Server it would drop the pages after it). A page the transport
        # refuses as too large, a page above the legacy size whose connection
        # keeps getting dropped, a page whose body stalled, or a page answered 401
        # after a body that outlived its token, is cut smaller and the remaining
        # items are re-paged from that page's own start. Only a 413 says something
        # about the deployment, so only that size sticks for later snapshots; the
        # size a stall leads to lasts this capture only, and the other snapshots
        # wait from the stall on, not from a 401 (SNAPSHOT_STALL_SHRINKS).
        start, first = 0, True
        page_bytes = self._snapshot_page_bytes
        shrinks = 0  # cuts of the page at `start` after a stall
        stalled = False  # this capture stalled since its last page landed
        while first or start < len(snapshot):
            end = snapshot.page_end(start, page_bytes, first=first)
            try:
                await self._post_snapshot_page(client, snapshot, start, end, first, on_progress)
            except (ConnectorNetworkError, httpx.HTTPStatusError) as exc:
                stall = _body_stalled(exc)
                # A 401 after a body that ran past the token's life is cut like a stall,
                # out of the same budget, but it says the path is slow, not stalled: the
                # small snapshots of other sessions pass, so no cool-down unless the
                # page cannot be cut at all.
                outlived = _outlived_token(exc)
                size = snapshot.page_size(start, end, first=first)
                smaller = _smaller_page_bytes(size, exc) if end - start > 1 else None
                if stall:
                    # Every other snapshot waits from the stall on, as after a page given
                    # up at once, until a page of this capture gets through. Cut no more
                    # often than this: then the page is given up as a stall always was.
                    self._defer_snapshots(exc)
                    stalled = True
                if stall or outlived:
                    shrinks += 1
                    if shrinks > SNAPSHOT_STALL_SHRINKS:
                        smaller = None
                if smaller is None or self._closed is not None:
                    if outlived and smaller is None:
                        # Nothing left to cut: given up as a stall is, cool-down included,
                        # for a path this slow carries none of the other snapshots either.
                        self._defer_snapshots(exc)
                    if stall or outlived:
                        raise self._deferred(exc)
                    raise
                logger.warning(
                    "snapshot page of {} items and {} bytes failed ({}); re-paging the remaining {} items at {} bytes",
                    end - start, size, exc, len(snapshot) - start, smaller,
                )
                page_bytes = smaller
                if _too_large(exc):
                    self._snapshot_page_bytes = min(self._snapshot_page_bytes, smaller)
                continue
            start, first = end, False
            shrinks = 0
            if stalled:
                # A page got through after the stall: the path carries bulk again, and
                # the other snapshots need not wait for the rest of this capture. The
                # next stall of it counts as a first one.
                self._reset_snapshot_wait()
                stalled = False

    async def _post_snapshot_page(
        self, client, snapshot: EncodedSnapshot, start: int, end: int, first: bool, on_progress: UploadProgress | None,
    ) -> None:
        attempt = read_timeouts = 0
        size = snapshot.page_size(start, end, first=first)
        while True:
            # The Server checks the token only after the whole body arrived, so the token
            # must outlive the page: a reused one may have a minute left, and a large page
            # takes longer than that. Only the first attempt of a page above the legacy
            # size forces a fresh one; a retry of it, and a smaller page, go with the cache.
            token = await self._access_token_provider(attempt == 0 and size > SNAPSHOT_LEGACY_PAGE_BYTES)
            try:
                await self._send_with_auth(
                    lambda token, read_timeouts=read_timeouts: self._post_snapshot_body(
                        client, token, snapshot, start, end, first, on_progress, read_timeouts,
                    ),
                    token, size=size, page=True,
                )
                return
            except ConnectorNetworkError as exc:
                if _body_stalled(exc) or _outlived_token(exc):
                    # No progress for the whole write timeout, or a 401 after a body that
                    # ran past the token's life: sent again at this size the page only
                    # keeps the path busy. _post_snapshot_pages cuts the page smaller.
                    raise
                attempt += 1
                read_timeouts += _read_timed_out(exc)
                if attempt > SNAPSHOT_PAGE_RETRIES or self._closed is not None:
                    raise
                logger.warning("snapshot page at item {}/{} failed ({}); retrying", start, len(snapshot), exc)
                await asyncio.sleep(SNAPSHOT_PAGE_RETRY_BACKOFF_SECONDS * 2 ** (attempt - 1))

    async def _post_snapshot_body(
        self, client, token, snapshot: EncodedSnapshot, start: int, end: int, first: bool,
        on_progress: UploadProgress | None, read_timeouts: int = 0,
    ):
        size = snapshot.page_size(start, end, first=first)
        sent = _PageSend(size)

        async def stream():
            for chunk in snapshot.page_chunks(start, end, first=first, chunk_bytes=UPLOAD_CHUNK_BYTES):
                yield chunk
                # Resumed: the transport took the chunk and asks for the next.
                sent.written += len(chunk)
                if on_progress is not None:
                    await on_progress(len(chunk))

        try:
            return await client.post(
                api_v2_url(self._server_url, "/connector/ingest"),
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Content-Length": str(size)},
                # The Server answers only after parsing and applying the whole page;
                # a page given up too early is uploaded again.
                content=stream(), timeout=upload_timeout(size, read_timeouts=read_timeouts),
            )
        except httpx.RequestError as exc:
            # Only the sender knows how far the body got; the error is wrapped above.
            sent.failed()
            exc.page_send = sent
            raise

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
                await self._post_batch_retrying(notifications, on_progress=on_progress)
            finally:
                self._posting = False
                if not self.has_pending:
                    self._available.clear()

    async def _drain_pending(self, on_progress):
        # Preserve FIFO ahead of a synchronous snapshot; only drain work queued at admission.
        remaining = len(self._inflight) + self._notify_queue.qsize()
        while remaining:
            self._collect_pending()
            await self._post_batch_retrying(self._inflight, on_progress=on_progress)
            remaining = max(0, remaining - len(self._inflight))
            self._inflight = []

    async def _post_batch_retrying(self, notifications: list[dict[str, Any]], *, on_progress: UploadProgress | None = None) -> None:
        attempt = read_timeouts = 0
        while True:
            try:
                await self._post_batch(notifications, on_progress=on_progress, read_timeouts=read_timeouts)
                return
            except ConnectorNetworkError as exc:
                attempt += 1
                read_timeouts += _read_timed_out(exc)
                if attempt > SYNC_BATCH_RETRIES or self._closed is not None:
                    raise
                logger.warning("connector ingest batch failed notifications={} attempt={} ({}); retrying", len(notifications), attempt, exc)
                await asyncio.sleep(SYNC_BATCH_RETRY_BACKOFF_SECONDS * 2 ** (attempt - 1))

    async def _post_batch(
        self, notifications: list[dict[str, Any]], *, on_progress: UploadProgress | None = None, read_timeouts: int = 0,
    ) -> None:
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
        encoded = json.dumps(
            {"notifications": notifications}, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
        ).encode("utf-8", UTF8_REPLACE_LONE_SURROGATES)
        try:
            await self._send_with_auth(
                lambda token: self._post_ingest_batch(
                    client, token, encoded, on_progress=on_progress, read_timeouts=read_timeouts,
                ),
                token, size=len(encoded),
            )
        finally:
            if owned:
                await client.aclose()

    async def _send_with_auth(self, send, token, *, size: int, page: bool = False):
        started = time.monotonic()
        try:
            response = await send(token)
            if getattr(response, "status_code", None) == 401:
                if page and time.monotonic() - started >= SNAPSHOT_TOKEN_OUTLIVED_SECONDS:
                    # The Server answers a page 401 only once its whole body arrived: one
                    # whose body ran past the token's life was paid for in full, and would
                    # be again. _post_snapshot_pages cuts it instead (SNAPSHOT_TOKEN_OUTLIVED_SECONDS).
                    # Only a page can be cut: a batch is sent again whatever its body took.
                    raise ConnectorPageOutlivedTokenError(
                        f"backend ingest request outlived its access token: HTTP 401 "
                        f"(body {size} bytes, after {time.monotonic() - started:.1f}s)"
                    )
                token = await self._access_token_provider(True)
                response = await send(token)
                if getattr(response, "status_code", None) == 401:
                    raise ConnectorAuthenticationError("connector credential no longer valid")
        except httpx.RequestError as exc:
            # httpx timeouts have an empty message, so the type is what tells them
            # from a dropped connection; the size and time show which limit it hit.
            raise ConnectorNetworkError(
                f"backend ingest request failed: {type(exc).__name__}: {exc} "
                f"(body {size} bytes, after {time.monotonic() - started:.1f}s)"
            ) from exc
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
        encoded: bytes,
        *, on_progress: UploadProgress | None = None, read_timeouts: int = 0,
    ) -> httpx.Response:
        content: bytes | AsyncIterator[bytes] = encoded
        if on_progress is not None:
            async def body():
                for offset in range(0, len(encoded), UPLOAD_CHUNK_BYTES):
                    chunk = encoded[offset:offset + UPLOAD_CHUNK_BYTES]
                    yield chunk
                    # Resumption means the transport accepted the previous write.
                    # This is liveness only; cloud acceptance still gates ACK/save.
                    await on_progress(len(chunk))

            content = body()
        return await client.post(
            api_v2_url(self._server_url, "/connector/ingest"),
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json", "Content-Length": str(len(encoded))},
            content=content,
            timeout=upload_timeout(len(encoded), read_timeouts=read_timeouts),
        )


def upload_timeout(size: int, *, read_timeouts: int = 0) -> httpx.Timeout:
    """Timeouts for a request body of ``size`` bytes after ``read_timeouts`` read
    timeouts of the same body; see ``UPLOAD_SLOWEST_BYTES_PER_SECOND``."""
    return httpx.Timeout(
        UPLOAD_STALL_SECONDS,
        connect=UPLOAD_CONNECT_SECONDS,
        read=(UPLOAD_STALL_SECONDS + size / UPLOAD_SLOWEST_BYTES_PER_SECOND) * 2 ** read_timeouts,
    )


def _read_timed_out(error: Exception) -> bool:
    return isinstance(error.__cause__, httpx.ReadTimeout)


def _body_stalled(error: Exception) -> bool:
    return isinstance(error.__cause__, httpx.WriteTimeout)


def _outlived_token(error: BaseException) -> bool:
    """Whether a page's 401 came after a body that ran past the token's life.

    The error is raised in _send_with_auth and reaches _post_snapshot_page and
    _post_snapshot_pages as it is: nothing on the way wraps it (the wrapping of
    httpx errors happens below, in _send_with_auth), so the type is read off
    the error itself, not its cause.
    """
    return isinstance(error, ConnectorPageOutlivedTokenError)


def _page_send(error: Exception) -> _PageSend | None:
    """How far the body of a stalled page got; None for a body that was not a page."""
    return getattr(error.__cause__, "page_send", None)


def _snapshot_stall_wait(stalls: int) -> float:
    return min(SNAPSHOT_STALL_WAIT_MAX_SECONDS, SNAPSHOT_STALL_WAIT_SECONDS * 2 ** (stalls - 1))


def _too_large(error: Exception) -> bool:
    return isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 413


def _smaller_page_bytes(size: int, error: Exception) -> int | None:
    """The page size to re-page with after a page of ``size`` bytes failed, or ``None`` to give up."""

    if _too_large(error):
        smaller = size // 2
        return smaller if smaller >= SNAPSHOT_MIN_PAGE_BYTES else None
    if _body_stalled(error) or _outlived_token(error):
        # The path could not carry this page, whatever any proxy's limit: to the
        # legacy size first, as a large page whose connection keeps dropping, then
        # halved as for a 413, and never below the floor. A page whose body outlived
        # its token is cut the same way: it needs a shorter body, not a new token.
        smaller = SNAPSHOT_LEGACY_PAGE_BYTES if size > SNAPSHOT_LEGACY_PAGE_BYTES else size // 2
        return smaller if smaller >= SNAPSHOT_MIN_PAGE_BYTES else None
    if size > SNAPSHOT_LEGACY_PAGE_BYTES and isinstance(
        error.__cause__, httpx.WriteError | httpx.ReadError | httpx.RemoteProtocolError,
    ):
        # Some proxies drop an oversized upload instead of answering 413. A
        # Server that is down, slow or answering 5xx is not a size problem.
        return SNAPSHOT_LEGACY_PAGE_BYTES
    return None


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
    error_type = (
        ConnectorIngestRetryableError
        if _rejection_is_retryable(rejected)
        else ConnectorIngestRejectedError
    )
    suffix = " (retryable)" if error_type is ConnectorIngestRetryableError else ""
    raise error_type(
        f"backend ingest rejected {len(rejected)} notification(s); "
        f"first method={method} code={code}: {message}{suffix}"
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
