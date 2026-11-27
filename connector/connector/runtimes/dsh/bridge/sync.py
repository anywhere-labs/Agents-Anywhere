from __future__ import annotations

import asyncio
import pickle
import sys
import tempfile
import uuid
from collections.abc import Awaitable, Callable, Iterator, Mapping
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from meshcall import MeshCallError

from connector.logging import logger
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.models import (
    SessionSourceObservation,
    SessionSourceState,
)
from connector.runtimes.dsh.bridge.client import BridgeClient
from connector.runtimes.dsh.bridge.host import (
    SUBSCRIPTION_UNKNOWN,
    SnapshotPage,
    SnapshotRequest,
    SnapshotResult,
    SyncBatch,
)
from connector.runtimes.dsh.bridge.models import (
    capability_set,
    model_catalog,
    permission_catalog,
    session_meta,
    session_state,
    timeline_item,
)
from connector.runtimes.dsh.bridge.models import notice as session_notice
from connector.server.errors import ConnectorNetworkError
from connector.server.ingest import (
    ConnectorIngestDeferredError,
    ConnectorIngestRejectedError,
)

# Consecutive subscription failures back off up to this long between attempts.
MAX_RETRY_DELAY_SECONDS = 30.0
# How long an ingest call waits for its subscription's "subscribed" item.
SUBSCRIBE_CONFIRM_TIMEOUT_SECONDS = 30.0
# A streaming reply rewrites its draft items many times a second. Once two
# batches in a row carry only still-running items, each such batch is posted at
# once but acknowledged no sooner than this after its post started; the plugin
# merges the chunks that arrive meanwhile into its next batch. A single draft
# batch between other work (another session's baseline, say) is not held.
STREAMING_POST_INTERVAL_SECONDS = 0.25

# Called once when the relay task ends for any reason other than close().
RelayExitHandler = Callable[["SyncRelay", BaseException | None], None]

# Sync progress is a phase of a usable runtime: session reads and commands go
# straight to the Bridge and do not wait for the event feed. Only a lost Bridge
# makes the runtime unusable, and that is reported by the runtime itself (#504).
SYNCING_PHASE = {"code": "syncing", "message": "正在同步 DSH 会话…", "retryable": True}
SYNC_INTERRUPTED_PHASE = {"code": "sync_interrupted", "message": "DSH 会话同步中断，正在重试…", "retryable": True}

_DURABLE_NOTIFICATIONS = {
    "timeline.itemUpsert", "session.meta.upsert", "session.state.updated",
    "session.source.updated", "session.turnEnded",
    "session.inventory.begin", "session.inventory.complete",
}

# A session whose complete snapshot the backend refused for good (413, another
# 4xx, or an HTTP 200 listing the notification as rejected) must not hold back
# the other sessions. The commit is acknowledged so the feed moves on, but no
# checkpoint is saved for it, its live history is withheld (it would land on a
# timeline that never received a baseline) and a fresh capture is requested
# after a growing delay. Captures the plugin makes before then are acknowledged
# without uploading. Transient failures keep the resubscribe path.
# A snapshot the ingest client deferred, because an earlier upload stalled and
# its cool-down is still on, is quarantined the same way until that cool-down
# is over. Failing the capture instead would end the feed, and every resubscribe
# would capture every session again, about a second apart, for as long as the
# cool-down lasts.
# Not so when this session's own page stalled. The ingest client's cool-down only
# says when it takes snapshots again, not whether this page can get through now:
# a page too much for the path as it was is not less so that soon, and sent again
# it only keeps the path busy, with every other session's snapshot behind it
# (on a weak link, one 45 MiB page stalled four times, and 19 of 20 other
# snapshots were never sent). That session is asked for again after a
# backoff of its own, which doubles with each further stall of it, capped here,
# and starts over once one of its uploads gets through. Only its own stalls
# count: a refusal unsent behind another session's stall says nothing about
# its page.
STALL_RETRY_BASE_SECONDS = 600.0
STALL_RETRY_MAX_SECONDS = 3600.0
QUARANTINE_RETRY_DELAY_SECONDS = 30.0
QUARANTINE_TOO_LARGE_RETRY_DELAY_SECONDS = 5 * 60.0
QUARANTINE_MAX_RETRY_DELAY_SECONDS = 30 * 60.0
_QUARANTINED_HISTORY = {"timeline.itemUpsert", "session.turnEnded"}


@dataclass
class _Quarantine:
    external_session_id: str | None
    through_seq: Any
    reason: str  # history_too_large | history_rejected | history_deferred
    attempts: int = 1
    # Live history arrived while quarantined; the next capture must be fresh.
    stale: bool = False
    # Event loop time from which a capture of this session is uploaded again.
    retry_at: float = 0.0
    # This session's own page stalled (history_deferred only). retry_at is then its
    # own backoff, which the ingest client's cool-down ending does not shorten.
    stalled: bool = False
    # Own stalls of the session since its last upload got through. A record left by
    # another reason carries the count on, so the next own stall goes on growing.
    stalls: int = 0

    def source_state(self) -> dict[str, Any]:
        return {"availability": "unavailable", "reason": self.reason,
                "observedAt": _observed_now(), "observationOrigin": "event"}


def _with_event_time(items: Iterator[dict[str, Any]], activity: Any) -> Iterator[dict[str, Any]]:
    """Date replayed items with their own DSH event time when they carry no time.

    DSH items keep their event time only inside ``source``, so the backend dates an
    untimed item with the moment it was ingested. For a complete capture that is
    the sync moment: a first import, or any re-capture, would sort every session
    by the order this relay happened to walk them instead of by when it was used.
    An item without an event time falls back to the session's last activity, as
    the polling path does with the session's ordering time. Items that already
    carry a time keep it.
    """
    fallback = activity if isinstance(activity, str) and activity else None
    for item in items:
        source = item.get("source")
        time = (_event_time(source.get("time")) if isinstance(source, Mapping) else None) or fallback
        yield item if time is None else {"createdAt": time, "updatedAt": time, **item}


def _event_time(value: Any) -> str | None:
    """Turn a DSH event time (epoch milliseconds) into the backend's ISO form."""
    if isinstance(value, bool) or not isinstance(value, int | float) or not value > 0:
        return None
    try:
        moment = datetime.fromtimestamp(value / 1000, UTC)
    except (OverflowError, OSError, ValueError):
        return None
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _checkpoint(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, Mapping):
        return None
    seq, fingerprint = value.get("throughSeq"), value.get("historyHash")
    if (value.get("version") != 1 or value.get("projectionVersion") not in (2, 3)
        or type(seq) is not int or not -1 <= seq <= 9007199254740991
        or type(value.get("settled")) is not bool or not isinstance(fingerprint, str)
        or len(fingerprint) != 64 or any(c not in "0123456789abcdef" for c in fingerprint)):
        return None
    return {key: value[key] for key in ("version", "projectionVersion", "throughSeq", "historyHash", "settled")}


class SyncRelay:
    """Reassemble transport pages, then forward existing platform notifications.

    No native event parsing or backend-specific persistence protocol lives here.
    The relay opens the plugin's ``sync`` stream, which lives as long as the
    subscription; the plugin hands each batch over with ``Sync.ingestBatch``,
    and that call returns only after every operation in it was ingested.
    """

    def __init__(
        self,
        client: BridgeClient,
        host: RuntimeHostClient,
        *,
        retry_delay: float = 1.0,
        on_exit: RelayExitHandler | None = None,
        quarantine_retry_delay: float = QUARANTINE_RETRY_DELAY_SECONDS,
        quarantine_too_large_retry_delay: float = QUARANTINE_TOO_LARGE_RETRY_DELAY_SECONDS,
        quarantined: dict[str, _Quarantine] | None = None,
        snapshot_wait: Callable[[], float] | None = None,
        streaming_post_interval: float = STREAMING_POST_INTERVAL_SECONDS,
    ) -> None:
        self.client, self.host = client, host
        self.registry = client.host.registry
        self.subscription_id: str | None = None
        self.projection_version: int | None = None
        self.expected_batch = 1
        self.confirmed = asyncio.Event()
        self.ingest_lock = asyncio.Lock()
        # MeshCall runs each ingest call on its own task; close() cancels them
        # so a blocked upload cannot hold the lock during shutdown.
        self._ingest_tasks: set[asyncio.Task[Any]] = set()
        self._closing = False
        self._close_task: asyncio.Task[None] | None = None
        self.retry_delay = retry_delay
        self.on_exit = on_exit
        self.failures = 0
        self.quarantine_retry_delay = quarantine_retry_delay
        self.quarantine_too_large_retry_delay = quarantine_too_large_retry_delay
        # Platform session id -> refused capture. The runtime hands the same map
        # to every relay it builds, so neither a resubscription nor a rebuilt
        # relay uploads a refused session again before its retry is due.
        self.quarantined: dict[str, _Quarantine] = {} if quarantined is None else quarantined
        # The ingest client's say-so on its wait for snapshots (seconds left, 0 when it takes
        # them), for the sessions it deferred. None: the relay goes by retry_at alone.
        self.snapshot_wait = snapshot_wait
        self.wait_poll_interval = 1.0
        self.retry_tasks: set[asyncio.Task[None]] = set()
        # The retry task that speaks for a quarantined session right now (its newest refusal's).
        self.retry_owners: dict[str, asyncio.Task[None]] = {}
        self.streaming_post_interval = streaming_post_interval
        # When the previous post started, if it carried only drafts.
        self.last_draft_post = float("-inf")
        self.task: asyncio.Task[None] | None = None
        self.snapshot: dict[str, Any] | None = None
        self.file = None
        self.spool = ExitStack()
        self.items: list[dict[str, Any]] = []
        self.item_bytes = 0
        self.item_ids: set[str] = set()
        self.durable_checkpoints = False
        # The current subscription delivered its complete inventory.
        self.baseline_complete = False

    def start(self) -> None:
        self.task = asyncio.create_task(self.run(), name="dsh-event-sync")
        self.task.add_done_callback(self._finished)
        # Refusals an earlier relay recorded keep their retry schedule.
        for session_id, record in self.quarantined.items():
            self._schedule_retry(session_id, record)

    def _finished(self, task: asyncio.Task[None]) -> None:
        # Whatever ended the loop, the owner gets to decide whether to start a
        # new relay; a relay must never disappear silently.
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            logger.error("DSH event sync stopped unexpectedly ({}): {}", type(error).__name__, error)
        if self.on_exit is not None:
            self.on_exit(self, error)

    async def _baseline_completed(self) -> None:
        self.baseline_complete = True
        await self._report_health("running")

    async def _report_health(self, status: str, phase: dict[str, Any] | None = None) -> None:
        # Status is best effort: the backend socket may be down while the
        # bridge is fine, and a failed report must not take the sync with it.
        if not self.client.connected:
            # The runtime reports the lost Bridge; a late "running" must not overwrite it.
            return
        try:
            if phase is None:
                await self.host.runtime_health_update(status)
            else:
                await self.host.runtime_health_update(status, phase=phase)
        except Exception as error:  # noqa: BLE001 - reporting never interrupts sync
            logger.debug("DSH sync health report skipped ({})", type(error).__name__)

    async def close(self) -> None:
        if self._close_task is None:
            self._closing = True
            if self.subscription_id is not None:
                self.registry.remove(self.subscription_id, self)
            self.confirmed.set()
            self._close_task = asyncio.create_task(self._close())
        await asyncio.shield(self._close_task)

    async def _close(self) -> None:
        # subscribe() needs ingest_lock in its finally block. Cancel the uploads
        # holding that lock before waiting for either the uploads or subscription.
        tasks = list(self._ingest_tasks | self.retry_tasks)
        if self.task is not None:
            tasks.append(self.task)
        for task in tasks:
            if not task.done() and not task.cancelling():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.clear_snapshot()

    def clear_snapshot(self) -> None:
        self.spool.close()
        self.file, self.snapshot = None, None
        self.item_ids.clear()
        self.items = []
        self.item_bytes = 0

    async def operation(self, op: dict[str, Any]) -> None:
        kind = op.get("kind")
        if kind == "notifications":
            pending: list[dict[str, Any]] = []
            for raw in op["notifications"]:
                notice = self.unquarantined(raw)
                if notice is None:
                    continue
                if self.durable_checkpoints and notice.get("method") in _DURABLE_NOTIFICATIONS:
                    params = notice.get("params")
                    if not isinstance(params, dict):
                        raise ValueError("Invalid runtime notification")
                    if notice["method"] == "timeline.itemUpsert":
                        item = timeline_item(params["item"])
                        if item.session_id != params.get("sessionId"):
                            raise ValueError("Incremental item belongs to a different session")
                    pending.append(notice)
                else:
                    await self.ingest_notifications(pending)
                    pending = []
                    await self.publish_notification(notice)
            await self.ingest_notifications(pending)
        elif kind == "workspace.inventory":
            # Older plugin builds sent native project facts. Ignore those batches;
            # all project grouping and naming use the existing session cwd path.
            return
        else:
            raise ValueError(f"Unsupported bridge operation: {kind}")

    async def deliver_snapshot(self, session_id: str, snapshot: dict[str, Any]) -> None:
        meta = snapshot["meta"]
        items = _with_event_time(self.iter_items(), meta.get("lastActivityAt"))
        try:
            # With durable checkpoints every earlier notification of the feed has
            # landed before its capture, so the upload need not queue behind, or
            # hold back, the other notifications of the Connector.
            await self.host.publish_runtime_snapshot(
                "dsh", session_id, meta, items, ordered=not self.durable_checkpoints,
            )
        except (ConnectorIngestRejectedError, httpx.HTTPStatusError) as error:
            if isinstance(error, httpx.HTTPStatusError) and not 400 <= error.response.status_code < 500:
                raise
            await self.quarantine(session_id, meta.get("externalSessionId"), snapshot.get("throughSeq"), error)
            return
        except ConnectorIngestDeferredError as error:
            # Not landed: an earlier upload stalled and the cool-down is still on, or this
            # capture's own page stalled and was given up (error.stalled). Failing the
            # capture here would end the feed, and its resubscription would capture every
            # session again, about a second apart, for as long as either lasts.
            await self.quarantine(session_id, meta.get("externalSessionId"), snapshot.get("throughSeq"), error)
            return
        await self.release(session_id, meta)

    async def quarantine(self, session_id: str, external_id: str | None, through_seq: Any, error: Exception) -> None:
        """Isolate one session whose history the backend refused for good, or that waits for a slow path."""

        deferred = isinstance(error, ConnectorIngestDeferredError)
        # This session's own page stalled, as against a capture refused unsent because
        # another session's did: the path was too weak for this page in particular.
        stalled = deferred and error.stalled
        too_large = isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 413
        previous = self.quarantined.get(session_id)
        attempts = previous.attempts + 1 if previous is not None else 1
        reason = "history_deferred" if deferred else "history_too_large" if too_large else "history_rejected"
        # Only the session's own stalls grow its backoff: a refusal unsent while another
        # session's stall has the client cooling down is not one, and counted as one it had
        # a page that stalled once wait three times as long as it should.
        stalls = previous.stalls if previous is not None else 0
        if stalled:
            stalls += 1
            # Its own backoff, doubling with each further stall of the session: the client's
            # cool-down says when it takes snapshots again, not whether this page can get
            # through now. The exponent is bounded because the cap is reached at the third
            # doubling: weeks of stalls must not overflow the float.
            delay = min(STALL_RETRY_BASE_SECONDS * 2 ** min(stalls - 1, 3), STALL_RETRY_MAX_SECONDS)
        else:
            # A deferred upload is taken again when the ingest client takes snapshots again: it says when.
            delay = error.retry_in if deferred else min(
                self._retry_base(too_large) * 2 ** (attempts - 1), QUARANTINE_MAX_RETRY_DELAY_SECONDS,
            )
        record = _Quarantine(
            external_id, through_seq, reason,
            attempts=attempts, retry_at=asyncio.get_running_loop().time() + delay,
            stalled=stalled, stalls=stalls,
        )
        self.quarantined[session_id] = record
        # Captures are withheld until the retry, so it must exist even if the
        # report below fails.
        self._schedule_retry(session_id, record)
        if stalled:
            # The session's backoff, not the client's cool-down the error repeats: two
            # waits in one line read as one.
            logger.warning(
                "DSH session history deferred: its upload stalled; session quarantined "
                "session_id={} attempts={} stalls={} backoff={:.0f}s error={}",
                session_id, record.attempts, stalls, delay, error,
            )
        elif deferred:
            logger.warning(
                "DSH session history deferred: the path cannot carry it now; session quarantined until the wait is over "
                "session_id={} attempts={} retry_in={:.0f}s error={}",
                session_id, record.attempts, error.retry_in, error,
            )
        else:
            logger.warning(
                "DSH session history refused by the backend; session quarantined session_id={} reason={} attempts={} error={}",
                session_id, record.reason, record.attempts, error,
            )
        await self.host.publish_runtime_notifications("dsh", [{
            "method": "session.source.updated",
            "params": {"sessionId": session_id, "externalSessionId": external_id, **record.source_state()},
        }])

    def _retry_base(self, too_large: bool) -> float:
        return self.quarantine_too_large_retry_delay if too_large else self.quarantine_retry_delay

    def _schedule_retry(self, session_id: str, record: _Quarantine) -> None:
        task = asyncio.create_task(self.retry_capture(session_id, record), name="dsh-sync-quarantine-retry")
        self.retry_tasks.add(task)
        self.retry_owners[session_id] = task

        def answered(done: asyncio.Task[None]) -> None:
            self.retry_tasks.discard(done)
            if self.retry_owners.get(session_id) is done:
                del self.retry_owners[session_id]

        task.add_done_callback(answered)

    def _retry_pending(self, session_id: str) -> bool:
        """Whether a retry task of this session is still to ask, or is asking."""

        task = self.retry_owners.get(session_id)
        return task is not None and not task.done()

    async def retry_capture(self, session_id: str, record: _Quarantine) -> None:
        """Ask the plugin for a fresh complete capture of a quarantined session once it is due."""

        attempts = record.attempts
        delay = record.retry_at - asyncio.get_running_loop().time()
        # A deferral is over when the client's wait is: earlier than retry_at if an upload it
        # had admitted before the stall got through, later if a new stall grew it. The client
        # says; ask once it is over. The backoff of a failed request below is not touched.
        # Not so for a session whose own page stalled: its backoff is its own and runs in
        # full, whatever the client's wait does; that wait is waited for after it.
        deferred = record.reason == "history_deferred" and self.snapshot_wait is not None
        follows_wait = deferred and not record.stalled
        if follows_wait:
            # Not before retry_at, unless the wait is over before it: then at once.
            while delay > 0 and self.snapshot_wait() > 0:
                await asyncio.sleep(min(delay, self.wait_poll_interval))
                if self.quarantined.get(session_id) is not record:
                    return  # Released, or a newer refusal owns the retry.
                delay = record.retry_at - asyncio.get_running_loop().time()
            delay = min(delay, 0.0)
        while True:
            await asyncio.sleep(max(delay, 0.0))
            if self.quarantined.get(session_id) is not record:
                return  # Released, or a newer refusal owns the retry.
            if deferred and self.snapshot_wait() > 0:
                # A wait that began since keeps the client from taking a snapshot: ask once it
                # is over, after the backoff has run in full.
                while self.snapshot_wait() > 0:
                    await asyncio.sleep(self.wait_poll_interval)
                    if self.quarantined.get(session_id) is not record:
                        return
            try:
                await self.client.request("refreshSync", {
                    "sessionId": session_id, "externalSessionId": record.external_session_id,
                })
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - keep retrying this session only
                logger.warning("DSH quarantined session refresh failed session_id={} error_type={}", session_id, type(error).__name__)
                attempts += 1
                delay = min(
                    self._retry_base(record.reason == "history_too_large") * 2 ** (attempts - 1),
                    QUARANTINE_MAX_RETRY_DELAY_SECONDS,
                )
                continue
            if follows_wait and self.snapshot_wait() > 0:
                # A wait that began while the request was out keeps the capture it asked for:
                # the plugin drops its pages, and nothing here would ask again until the
                # session changes or the feed restarts. Ask once it is over.
                delay = 0.0
                continue
            return

    async def release(self, session_id: str, meta: Mapping[str, Any]) -> None:
        record = self.quarantined.pop(session_id, None)
        if record is None:
            return
        logger.info("DSH session history accepted after quarantine session_id={} attempts={}", session_id, record.attempts)
        source = meta.get("sourceState")
        if not isinstance(source, dict) or source.get("availability") != "available":
            source = {"availability": "available"}
        # The capture's own source fact may predate the "unavailable" observation
        # published while it was refused; restate it as of now.
        await self.host.publish_runtime_notifications("dsh", [{
            "method": "session.source.updated",
            "params": {"sessionId": session_id, "externalSessionId": meta.get("externalSessionId"),
                       **source, "observedAt": _observed_now(), "observationOrigin": "event"},
        }])

    def unquarantined(self, notice: dict[str, Any]) -> dict[str, Any] | None:
        """Drop or rewrite a plugin notification that would contradict a quarantine."""

        if not self.quarantined:
            return notice
        method, params = notice.get("method"), notice.get("params")
        if not isinstance(params, dict):
            return notice
        record = self._quarantine_for(params)
        if record is not None:
            if method in _QUARANTINED_HISTORY:
                record.stale = True
                return None
            if method == "session.source.updated" and params.get("availability") == "available":
                return None
            source = params.get("sourceState")
            if method == "session.meta.upsert" and isinstance(source, dict) and source.get("availability") == "available":
                return {**notice, "params": {**params, "sourceState": record.source_state()}}
        if method == "session.inventory.complete" and isinstance(params.get("sessions"), list):
            sessions = [
                {**entry, "sourceState": quarantined.source_state()}
                if isinstance(entry, dict) and (quarantined := self._quarantine_for(entry)) is not None else entry
                for entry in params["sessions"]
            ]
            return {**notice, "params": {**params, "sessions": sessions}}
        return notice

    def _quarantine_for(self, params: Mapping[str, Any]) -> _Quarantine | None:
        session_id = params.get("sessionId")
        return self.quarantined.get(session_id) if isinstance(session_id, str) else None

    async def ingest_notifications(self, notifications: list[dict[str, Any]]) -> None:
        if not notifications:
            return
        loop = asyncio.get_running_loop()
        drafts = all(_streaming_draft(notice) for notice in notifications)
        started = loop.time()
        await self.host.publish_runtime_notifications("dsh", notifications)
        streaming = drafts and self.last_draft_post > float("-inf")
        self.last_draft_post = started if drafts else float("-inf")
        if streaming and (hold := started + self.streaming_post_interval - loop.time()) > 0:
            await asyncio.sleep(hold)
        if any(n["method"] == "session.inventory.complete" and n["params"].get("complete") is True for n in notifications):
            await self._baseline_completed()

    async def store_items(self, items: list[dict[str, Any]]) -> None:
        self.item_bytes += object_bytes(items)
        if self.file is None and self.item_bytes <= 8 * 1024 * 1024:
            self.items.extend(items)
            return
        # Keep only one capture in RAM. Pickle is internal, never accepted from a peer.
        # Wait for disk work even on cancellation before close_snapshot can close the file.
        def write() -> None:
            if self.file is None:
                self.file = self.spool.enter_context(tempfile.TemporaryFile(mode="w+b"))  # noqa: SIM115 - capture lifetime spans pages
                pickle.dump(self.items, self.file, protocol=pickle.HIGHEST_PROTOCOL)
                self.items = []
            pickle.dump(items, self.file, protocol=pickle.HIGHEST_PROTOCOL)
        task = asyncio.create_task(asyncio.to_thread(write))
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise

    def iter_items(self) -> Iterator[dict[str, Any]]:
        if self.file is None:
            yield from self.items
            return
        self.file.seek(0)
        while True:
            try:
                page = pickle.load(self.file)
            except EOFError:
                return
            yield from page

    async def publish_notification(self, notice: dict[str, Any]) -> None:
        method, params = notice.get("method"), notice.get("params")
        if not isinstance(params, dict):
            raise ValueError("Invalid runtime notification")  # noqa: TRY004 - protocol validation error
        # Use the existing typed Host API, just like Codex and Claude. The Host
        # owns instance binding, coalescing, WebSocket delivery and HTTP fallback.
        if method == "planning.observed":
            from connector.runtime_protocol.planning import PlanningObservation
            await self.host.observe_planning(PlanningObservation(session_id=params["sessionId"],
                external_session_id=params.get("externalSessionId"), kind=params["kind"],
                native_id=params.get("nativeId", ""), text=params.get("text", ""), mode=params.get("mode", "unknown")))
        elif method == "timeline.itemUpsert":
            item = timeline_item(params["item"])
            if item.session_id != params.get("sessionId"):
                raise ValueError("Incremental item belongs to a different session")
            await self.host.timeline_item_upsert(item)
        elif method == "session.meta.upsert":
            meta = session_meta(params)
            await self.host.session_meta_upsert(
                session_id=meta.session_id, runtime="dsh", external_session_id=meta.external_session_id,
                title=meta.title, cwd=meta.cwd, ordering_time=meta.ordering_time, metadata=meta.metadata,
            )
        elif method == "session.state.updated":
            state = session_state(params)
            await self.host.session_state_update(
                session_id=state.session_id, runtime="dsh", external_session_id=state.external_session_id,
                status=state.status, selections=state.selections, status_reason=state.status_reason,
                error=state.error, metadata=state.metadata,
            )
        elif method == "session.source.updated":
            await self.host.session_source_update(SessionSourceObservation(
                session_id=params["sessionId"], external_session_id=params.get("externalSessionId"), runtime="dsh",
                state=SessionSourceState(availability=params["availability"], reason=params.get("reason"),
                    observed_at=params.get("observedAt"), observation_origin=params.get("observationOrigin", "event")),
            ))
        elif method == "session.turnEnded":
            await self.host.session_turn_ended(
                session_id=params["sessionId"], runtime="dsh", external_session_id=params.get("externalSessionId"),
                turn_id=params.get("turnId"), outcome=params.get("outcome", "completed"), metadata=params.get("metadata"),
            )
        elif method == "notice.upsert":
            from connector.runtimes.dsh.planning import observe_dsh_notice
            if not await observe_dsh_notice(self.host, params):
                await self.host.notice_upsert(session_notice(params))
        elif method == "runtime.capability.updated":
            await self.host.runtime_capabilities_update(capability_set(params, connector_id=self.host.connector_id))
        elif method == "session.capability.updated":
            await self.host.session_capabilities_update(capability_set(params, connector_id=self.host.connector_id))
        elif method == "catalog.model.update":
            await self.host.model_catalog_update(model_catalog(params))
        elif method == "catalog.permission.update":
            await self.host.permission_catalog_update(permission_catalog(params))
        elif method in {"session.inventory.begin", "session.inventory.complete"}:
            await self.host.publish_runtime_notifications("dsh", [notice])
            if method == "session.inventory.complete" and params.get("complete") is True:
                await self._baseline_completed()
        else:
            raise ValueError(f"Unsupported runtime notification: {method}")

    async def run(self) -> None:
        try:
            while True:
                try:
                    await self.subscribe()
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001 - isolate and recover a failed feed
                    self.failures += 1
                    delay = min(self.retry_delay * 2 ** (self.failures - 1), MAX_RETRY_DELAY_SECONDS)
                    logger.warning(
                        "DSH event sync interrupted; resubscribing in {:.1f}s ({}: {})",
                        delay, type(error).__name__, error,
                    )
                    if not self.client.connected:
                        return
                    await self._report_health("running", SYNC_INTERRUPTED_PHASE)
                    self.clear_snapshot()
                    await asyncio.sleep(delay)
        finally:
            self.clear_snapshot()

    async def subscribe(self) -> None:
        """Run the plugin's sync stream for as long as it stays open."""
        subscription_id = uuid.uuid4().hex
        self.registry.add(subscription_id, self)
        self.subscription_id = subscription_id
        self.projection_version = None
        self.expected_batch = 1
        self.baseline_complete = False
        self.confirmed.clear()
        try:
            await self._report_health("running", SYNCING_PHASE)
            async for event in self.client.stream("sync", {"subscriptionId": subscription_id, "checkpointVersion": 1}):
                if event.get("kind") != "subscribed":
                    continue
                if event.get("projectionVersion") not in (2, 3):
                    raise ValueError("Unsupported DSH projection version")
                self.durable_checkpoints = event.get("checkpointVersion") == 1
                self.projection_version = event["projectionVersion"]
                self.confirmed.set()
            raise RuntimeError("The DSH plugin ended the sync stream")
        finally:
            self.registry.remove(subscription_id, self)
            self.subscription_id = None
            self.confirmed.set()
            async with self.ingest_lock:
                self.clear_snapshot()

    async def ingest(self, batch: SyncBatch) -> None:
        """Run one batch; returning is the plugin's acknowledgement."""
        task = asyncio.current_task()
        if task is not None:
            self._ingest_tasks.add(task)
        try:
            await self._await_subscription()
            await self._ingest_locked(batch)
        except (asyncio.CancelledError, MeshCallError, ConnectorNetworkError):
            # An unreachable Server is retried by the plugin, not a rejected batch.
            raise
        except Exception as error:
            # The plugin only sees an internal error; keep the facts that decided it.
            logger.warning(
                "DSH sync batch rejected subscription={} batch_subscription={} batch_seq={} expected_batch={} "
                "projection={} batch_projection={} operations={} error={}: {}",
                self.subscription_id, batch.subscriptionId, batch.batchSeq, self.expected_batch,
                self.projection_version, batch.projectionVersion, len(batch.operations), type(error).__name__, error,
            )
            raise
        finally:
            if task is not None:
                self._ingest_tasks.discard(task)

    async def _ingest_locked(self, batch: SyncBatch) -> None:
        async with self.ingest_lock:
            if batch.subscriptionId != self.subscription_id or self.projection_version is None:
                # Not acknowledged: the plugin saves checkpoints only after an
                # acknowledgement, and this batch was never applied.
                raise MeshCallError(SUBSCRIPTION_UNKNOWN, "The DSH sync subscription already ended")
            if batch.batchSeq == self.expected_batch - 1:
                # A delivery whose acknowledgement was lost may be retried; the
                # original application already advanced the sequence, so acking
                # it again keeps the declared idempotency instead of failing the
                # whole feed as out-of-order.
                return
            if batch.batchSeq != self.expected_batch:
                raise ValueError("Out-of-order event batch; resubscribe to recalibrate")
            if batch.projectionVersion != self.projection_version:
                raise ValueError("Invalid DSH event batch")
            for operation in batch.operations:
                await self.operation(operation)
            self.expected_batch += 1
            self.failures = 0

    async def serialized[T](self, operation: Callable[[], Awaitable[T]]) -> T:
        """Run one snapshot or checkpoint operation with the batches, tracked for close()."""
        self._ensure_open()
        task = asyncio.current_task()
        if task is not None:
            self._ingest_tasks.add(task)
        try:
            async with self.ingest_lock:
                self._ensure_open()
                return await operation()
        finally:
            if task is not None:
                self._ingest_tasks.discard(task)

    async def _await_subscription(self) -> None:
        self._ensure_open()
        await asyncio.wait_for(self.confirmed.wait(), SUBSCRIBE_CONFIRM_TIMEOUT_SECONDS)
        self._ensure_open()

    def _ensure_open(self) -> None:
        if self._closing:
            raise RuntimeError("The DSH sync relay is closing")

    async def load_checkpoint(self, external_session_id: str) -> dict[str, Any] | None:
        await self._await_subscription()
        if not self.durable_checkpoints:
            return None
        return _checkpoint(await self.host.sync_state_read(f"dsh/sync/checkpoints/{external_session_id}"))

    async def save_checkpoint(self, external_session_id: str, checkpoint: dict[str, Any]) -> None:
        await self._await_subscription()
        if not self.durable_checkpoints:
            return
        value = _checkpoint(checkpoint)
        if value is None:
            raise ValueError("Invalid DSH checkpoint")
        if any(record.external_session_id == external_session_id for record in self.quarantined.values()):
            # The plugin believes its capture was ingested; it was not.
            # A later subscription must not resume from that boundary.
            logger.debug("DSH checkpoint withheld for quarantined session external_id={}", external_session_id)
            return
        await self.host.sync_state_write(f"dsh/sync/checkpoints/{external_session_id}", value)

    async def delete_checkpoint(self, external_session_id: str) -> None:
        await self._await_subscription()
        await self.host.sync_state_delete(f"dsh/sync/checkpoints/{external_session_id}")

    async def begin_snapshot(self, request: SnapshotRequest) -> None:
        self.clear_snapshot()
        record = self.quarantined.get(request.sessionId)
        withheld = record is not None and asyncio.get_running_loop().time() < record.retry_at
        if (withheld and record.reason == "history_deferred" and not record.stalled
                and self.snapshot_wait is not None and self.snapshot_wait() <= 0):
            # The client's wait ended early (an upload it had admitted before the stall got
            # through): this capture can land now. Not one of a session whose own page
            # stalled: that waits for its backoff, whatever the client's wait does.
            withheld = False
        self.snapshot = {"captureId": request.captureId, "sessionId": request.sessionId,
                         "meta": request.meta, "throughSeq": request.throughSeq,
                         # The plugin captures an unpublished session again on each of its
                         # changes. Before the retry is due such a capture would only be
                         # refused again: drop its pages and keep the quarantine.
                         "withheld": withheld}

    async def add_snapshot_page(self, page: SnapshotPage) -> None:
        snapshot = self.snapshot
        if snapshot is None:
            raise ValueError("Snapshot page outside a capture")
        if page.captureId != snapshot["captureId"]:
            raise ValueError("Snapshot page belongs to a different capture")
        if snapshot["withheld"]:
            return
        for raw in page.items:
            item = timeline_item(raw)
            if item.session_id != snapshot["sessionId"] or item.id in self.item_ids:
                raise ValueError("Invalid snapshot item identity")
            self.item_ids.add(item.id)
        await self.store_items(page.items)

    async def commit_snapshot(self, capture_id: str | None = None) -> SnapshotResult:
        snapshot = self.snapshot
        if snapshot is None:
            raise ValueError("Snapshot commit outside a capture")
        if capture_id is not None and snapshot.get("captureId") != capture_id:
            raise ValueError("Snapshot commit belongs to a different capture")
        session_id = snapshot["sessionId"]
        withheld = snapshot["withheld"]
        if not withheld:
            await self.deliver_snapshot(session_id, snapshot)
        self.clear_snapshot()
        record = self.quarantined.get(session_id)
        if record is None:
            return SnapshotResult(accepted=True)
        if withheld:
            self._rearm_if_alone(session_id)
        return SnapshotResult(accepted=False, quarantined=True, reason=record.reason)

    def _rearm_if_alone(self, session_id: str) -> None:
        """Schedule the retry of a session whose withheld capture just ended, if nothing else will ask."""

        record = self.quarantined.get(session_id)
        if record is not None and not self._retry_pending(session_id):
            # The capture answered a retry that has been answered itself (the plugin answers
            # a refresh at once and captures after it does), and a wait that began since made
            # the relay drop it: nothing would ask again until the session changes or the
            # feed restarts. Ask once the wait is over.
            self._schedule_retry(session_id, record)

    async def abort_snapshot(self, capture_id: str | None = None) -> None:
        # A stale stream must not clear the capture its replacement started.
        if capture_id is not None and self.snapshot is not None and self.snapshot.get("captureId") != capture_id:
            return
        snapshot = self.snapshot
        self.clear_snapshot()
        if snapshot is not None and snapshot["withheld"] and not self._closing:
            # The plugin gave a withheld capture up (its read failed): as with a commit,
            # nothing would ask again until the session changes or the feed restarts.
            self._rearm_if_alone(snapshot["sessionId"])


def _streaming_draft(notice: Mapping[str, Any]) -> bool:
    params = notice.get("params")
    item = params.get("item") if isinstance(params, Mapping) else None
    return notice.get("method") == "timeline.itemUpsert" and isinstance(item, Mapping) and item.get("status") == "running"


def _observed_now() -> str:
    # Same shape as the plugin's Date.toISOString(); the backend orders
    # observations by comparing these strings.
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def object_bytes(value: Any) -> int:
    """Conservative retained size for decoded JSON, without serializing it again."""
    if isinstance(value, dict):
        return sys.getsizeof(value) + sum(sys.getsizeof(key) + object_bytes(item) for key, item in value.items())
    if isinstance(value, list):
        return sys.getsizeof(value) + sum(object_bytes(item) for item in value)
    return sys.getsizeof(value)
