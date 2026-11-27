from __future__ import annotations

import asyncio

from connector.server.ingest import ConnectorIngestDeferredError

# An upload of this queue whose own body stalled is not sent again as soon as the
# ingest client's cool-down is over: a page too much for the path as it was is not
# less so that soon, and sent again it only keeps the path busy. The queue waits a
# backoff of its own, which doubles with each further stall of it, capped here, and
# starts over once an upload gets through.
STALL_RETRY_BASE_SECONDS = 600.0
STALL_RETRY_MAX_SECONDS = 3600.0


class SynchronizationService:
    def __init__(self, store, publish):
        self.store, self.publish = store, publish
        self.lock = asyncio.Lock()
        self.stopping = False
        self.task = None
        self.last_error: str | None = None
        # Stalls of this queue's own uploads since its last one got through. The outbox is
        # one ordered queue of the runtime, acknowledged only as a whole, so no row is ever
        # passed over: a success means the row whose page stalled got through.
        self.stalls = 0

    def _deferred_sleep(self, error: ConnectorIngestDeferredError) -> float:
        """How long to wait before asking again after the upload was deferred."""
        if not error.stalled:
            # Another upload stalled and the ingest client is cooling down: as long as it says.
            return error.retry_in
        self.stalls += 1
        # The exponent is bounded because the cap is reached at the third doubling:
        # weeks of stalls must not overflow the float.
        backoff = min(STALL_RETRY_BASE_SECONDS * 2 ** min(self.stalls - 1, 3), STALL_RETRY_MAX_SECONDS)
        return max(error.retry_in, backoff)

    def start(self):
        self.task = asyncio.create_task(self.run())

    async def flush(self):
        async with self.lock:
            while rows := self.store.pending():
                await self.publish([value for _, _, value in rows])
                with self.store.transaction():
                    self.store.acknowledge([key for _, key, _ in rows])
        self.stalls = 0

    async def run(self):
        while not self.stopping:
            try:
                await self.flush()
                self.last_error = None
            except ConnectorIngestDeferredError as error:
                # The queue is ordered: the rows behind the deferred one wait with it.
                # Asking again every second would only be told the same thing.
                self.last_error = type(error).__name__
                await asyncio.sleep(self._deferred_sleep(error))
                continue
            except Exception as error:  # noqa: BLE001 -- durable queue retains all unacknowledged facts
                self.last_error = type(error).__name__
            await asyncio.sleep(0.1 if self.last_error is None else 1)

    async def close(self):
        self.stopping = True
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
