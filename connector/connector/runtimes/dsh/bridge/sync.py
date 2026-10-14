from __future__ import annotations

import asyncio
import pickle
import sys
import tempfile
from collections.abc import Callable, Iterator, Mapping
from contextlib import ExitStack
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

from connector.logging import logger
from connector.runtime_protocol.host import RuntimeHostClient, UploadProgress
from connector.runtime_protocol.models import (
    SessionSourceObservation,
    SessionSourceState,
)
from connector.runtimes.dsh.bridge.client import BridgeClient
from connector.runtimes.dsh.bridge.models import (
    capability_set,
    model_catalog,
    permission_catalog,
    session_meta,
    session_state,
    timeline_item,
)
from connector.runtimes.dsh.bridge.models import notice as session_notice
from connector.server.ingest import ConnectorIngestRejectedError

# Consecutive subscription failures back off up to this long between attempts.
MAX_RETRY_DELAY_SECONDS = 30.0

# Called once when the relay task ends for any reason other than close().
RelayExitHandler = Callable[["SyncRelay", BaseException | None], None]

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
# after a growing delay. Transient failures keep the resubscribe path.
QUARANTINE_RETRY_DELAY_SECONDS = 30.0
QUARANTINE_TOO_LARGE_RETRY_DELAY_SECONDS = 5 * 60.0
QUARANTINE_MAX_RETRY_DELAY_SECONDS = 30 * 60.0
_QUARANTINED_HISTORY = {"timeline.itemUpsert", "session.turnEnded"}


@dataclass
class _Quarantine:
    external_session_id: str | None
    through_seq: Any
    reason: str  # history_too_large | history_rejected
    attempts: int = 1
    # Live history arrived while quarantined; the next capture must be fresh.
    stale: bool = False

    def source_state(self) -> dict[str, Any]:
        return {"availability": "unavailable", "reason": self.reason,
                "observedAt": _observed_now(), "observationOrigin": "event"}


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
    Checkpoint-capable feeds await ingestion for history-bearing notifications.
    Transport page ACKs alone never advance the Connector's persisted state.
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
    ) -> None:
        self.client, self.host = client, host
        self.queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=2)
        self.stream_id: str | None = None
        self.retry_delay = retry_delay
        self.on_exit = on_exit
        self.failures = 0
        self.quarantine_retry_delay = quarantine_retry_delay
        self.quarantine_too_large_retry_delay = quarantine_too_large_retry_delay
        # Platform session id -> refused capture. Survives resubscription so an
        # unchanged refused capture is not uploaded again and again.
        self.quarantined: dict[str, _Quarantine] = {}
        self.retry_tasks: set[asyncio.Task[None]] = set()
        self.task: asyncio.Task[None] | None = None
        self.snapshot: dict[str, Any] | None = None
        self.file = None
        self.spool = ExitStack()
        self.items: list[dict[str, Any]] = []
        self.item_bytes = 0
        self.item_ids: set[str] = set()
        self.durable_checkpoints = False
        self.loaded_checkpoint: dict[str, Any] | None = None
        self.on_progress: UploadProgress | None = None

    def start(self) -> None:
        self.task = asyncio.create_task(self.run(), name="dsh-event-sync")
        self.task.add_done_callback(self._finished)

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

    async def _report_health(self, status: str, phase: dict[str, Any] | None = None) -> None:
        # Status is best effort: the backend socket may be down while the
        # bridge is fine, and a failed report must not take the sync with it.
        try:
            if phase is None:
                await self.host.runtime_health_update(status)
            else:
                await self.host.runtime_health_update(status, phase=phase)
        except Exception as error:  # noqa: BLE001 - reporting never interrupts sync
            logger.debug("DSH sync health report skipped ({})", type(error).__name__)

    def accept(self, payload: Mapping[str, Any]) -> None:
        try:
            self.queue.put_nowait(dict(payload))
        except asyncio.QueueFull:
            self.restart()

    def restart(self, stream_id: str | None = None) -> None:
        if stream_id and self.stream_id and stream_id != self.stream_id:
            return
        while not self.queue.empty():
            self.queue.get_nowait()
        self.queue.put_nowait(None)

    async def close(self) -> None:
        if self.task and self.task is not asyncio.current_task():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        retries = list(self.retry_tasks)
        for retry in retries:
            retry.cancel()
        await asyncio.gather(*retries, return_exceptions=True)
        self.clear_snapshot()

    def clear_snapshot(self) -> None:
        self.spool.close()
        self.file, self.snapshot = None, None
        self.item_ids.clear()
        self.items = []
        self.item_bytes = 0

    async def operation(self, op: dict[str, Any]) -> None:
        kind = op.get("kind")
        if kind in {"checkpoint.load", "checkpoint.save", "checkpoint.delete"}:
            if not self.durable_checkpoints or self.snapshot is not None:
                raise ValueError("Checkpoint operation outside a committed sync boundary")
            external_id = op.get("externalSessionId")
            if not isinstance(external_id, str) or not external_id:
                raise ValueError("Checkpoint requires an external session identity")
            key = f"dsh/sync/checkpoints/{external_id}"
            if kind == "checkpoint.load":
                self.loaded_checkpoint = _checkpoint(await self.host.sync_state_read(key))
            elif kind == "checkpoint.delete":
                await self.host.sync_state_delete(key)
            else:
                checkpoint = _checkpoint(op.get("checkpoint"))
                if checkpoint is None:
                    raise ValueError("Invalid DSH checkpoint")
                if any(q.external_session_id == external_id for q in self.quarantined.values()):
                    # The plugin believes its capture was ingested; it was not.
                    # A later subscription must not resume from that boundary.
                    logger.debug("DSH checkpoint withheld for quarantined session external_id={}", external_id)
                    return
                # All preceding history operations were synchronously ingested.
                # The Host's periodic/final flush uses the same JSON as scanners.
                await self.host.sync_state_write(key, checkpoint)
        elif kind == "snapshot.begin":
            self.clear_snapshot()
            self.snapshot = op

        elif kind in {"snapshot.items", "snapshot.commit", "snapshot.abort"}:
            if not self.snapshot or any(op.get(k) != self.snapshot.get(k) for k in ("snapshotId", "sessionId")):
                raise ValueError("Snapshot page has a different capture identity")
            if kind == "snapshot.items":
                for raw in op["items"]:
                    item = timeline_item(raw)
                    if item.session_id != op["sessionId"] or item.id in self.item_ids:
                        raise ValueError("Invalid snapshot item identity")
                    self.item_ids.add(item.id)
                await self.store_items(op["items"])
            elif kind == "snapshot.commit":
                if len(self.item_ids) != op.get("totalItems") or op.get("throughSeq") != self.snapshot["throughSeq"]:
                    raise ValueError("Incomplete snapshot; previous backend history remains intact")
                await self.commit_snapshot(op["sessionId"], self.snapshot)
                self.clear_snapshot()
            else:
                self.clear_snapshot()
        elif kind == "notifications":
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
            # grouping is resolved server-side from explicit projects and cwd.
            return
        else:
            raise ValueError(f"Unsupported bridge operation: {kind}")

    async def commit_snapshot(self, session_id: str, snapshot: dict[str, Any]) -> None:
        meta = snapshot["meta"]
        kwargs = {"on_progress": self.on_progress} if self.on_progress is not None else {}
        try:
            await self.host.publish_runtime_snapshot("dsh", session_id, meta, self.iter_items(), **kwargs)
        except (ConnectorIngestRejectedError, httpx.HTTPStatusError) as error:
            if isinstance(error, httpx.HTTPStatusError) and not 400 <= error.response.status_code < 500:
                raise
            await self.quarantine(session_id, meta.get("externalSessionId"), snapshot.get("throughSeq"), error)
            return
        await self.release(session_id, meta)

    async def quarantine(self, session_id: str, external_id: str | None, through_seq: Any, error: Exception) -> None:
        """Isolate one session whose history the backend refused for good."""

        too_large = isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 413
        previous = self.quarantined.get(session_id)
        record = _Quarantine(
            external_id, through_seq,
            "history_too_large" if too_large else "history_rejected",
            attempts=previous.attempts + 1 if previous is not None else 1,
        )
        self.quarantined[session_id] = record
        logger.warning(
            "DSH session history refused by the backend; session quarantined session_id={} reason={} attempts={} error={}",
            session_id, record.reason, record.attempts, error,
        )
        await self.host.publish_runtime_notifications("dsh", [{
            "method": "session.source.updated",
            "params": {"sessionId": session_id, "externalSessionId": external_id, **record.source_state()},
        }])
        task = asyncio.create_task(self.retry_capture(session_id, record), name="dsh-sync-quarantine-retry")
        self.retry_tasks.add(task)
        task.add_done_callback(self.retry_tasks.discard)

    async def retry_capture(self, session_id: str, record: _Quarantine) -> None:
        """Ask the plugin for a fresh complete capture of a quarantined session."""

        base = self.quarantine_too_large_retry_delay if record.reason == "history_too_large" else self.quarantine_retry_delay
        attempts = record.attempts
        while True:
            await asyncio.sleep(min(base * 2 ** (attempts - 1), QUARANTINE_MAX_RETRY_DELAY_SECONDS))
            if self.quarantined.get(session_id) is not record:
                return  # Released, or a newer refusal owns the retry.
            try:
                await self.client.request("runtime.sync.refresh", {
                    "sessionId": session_id, "externalSessionId": record.external_session_id,
                })
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - keep retrying this session only
                logger.warning("DSH quarantined session refresh failed session_id={} error_type={}", session_id, type(error).__name__)
                attempts += 1
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
        kwargs = {"on_progress": self.on_progress} if self.on_progress is not None else {}
        await self.host.publish_runtime_notifications("dsh", notifications, **kwargs)
        if any(n["method"] == "session.inventory.complete" and n["params"].get("complete") is True for n in notifications):
            await self._report_health("running")

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
        if method == "timeline.itemUpsert":
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
            kwargs = {"on_progress": self.on_progress} if self.on_progress is not None else {}
            await self.host.publish_runtime_notifications("dsh", [notice], **kwargs)
            if method == "session.inventory.complete" and params.get("complete") is True:
                await self._report_health("running")
        else:
            raise ValueError(f"Unsupported runtime notification: {method}")

    async def run(self) -> None:
        try:
            while True:
                try:
                    await self.consume()
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001 - isolate and recover a failed feed
                    self.failures += 1
                    delay = min(self.retry_delay * 2 ** (self.failures - 1), MAX_RETRY_DELAY_SECONDS)
                    logger.warning(
                        "DSH event sync interrupted; resubscribing in {:.1f}s ({}: {})",
                        delay, type(error).__name__, error,
                    )
                    await self._report_health("starting", {
                        "code": "sync_interrupted", "message": "DSH 会话同步中断，正在重试…", "retryable": True,
                    })
                    if not self.client.connected:
                        return
                    self.clear_snapshot()
                    await asyncio.sleep(delay)
                    while not self.queue.empty():
                        self.queue.get_nowait()
        finally:
            self.clear_snapshot()

    async def consume(self) -> None:
        # Subscription replaces only this feed. Concurrent RPC requests keep
        # their connection and are never cancelled by an ingest/sync failure.
        try:
            await self._report_health("starting", {
                "code": "syncing", "message": "正在同步 DSH 会话…", "retryable": True,
            })
            subscription = await self.client.request("runtime.sync.subscribe", {"checkpointVersion": 1, "uploadProgressVersion": 1})
            projection_version = subscription.get("projectionVersion")
            if projection_version not in (2, 3):
                raise ValueError("Unsupported DSH projection version")
            stream_id, expected = subscription["streamId"], 1
            self.durable_checkpoints = subscription.get("checkpointVersion") == 1
            self.stream_id = stream_id
            progress_enabled = subscription.get("uploadProgressVersion") == 1
            while True:
                batch = await self.queue.get()
                if batch is None:
                    raise RuntimeError("The DSH sync stream needs a new subscription")
                if batch.get("streamId") != stream_id:
                    continue
                if batch.get("batchSeq") != expected:
                    raise ValueError("Out-of-order event batch; reconnect to recalibrate")
                if batch.get("projectionVersion") != projection_version or not isinstance(batch.get("operations"), list) or not batch["operations"]:
                    raise ValueError("Invalid DSH event batch")
                self.loaded_checkpoint = None
                batch_seq = expected
                bytes_sent = 0

                async def progress(bytes_written: int, seq: int = batch_seq) -> None:
                    nonlocal bytes_sent
                    bytes_sent += bytes_written
                    await self.client.request("runtime.sync.progress", {
                        "streamId": stream_id, "batchSeq": seq, "bytesSent": bytes_sent,
                    })

                self.on_progress = progress if progress_enabled else None
                for operation in batch["operations"]:
                    await self.operation(operation)
                ack = {"streamId": stream_id, "batchSeq": expected}
                if any(op.get("kind") == "checkpoint.load" for op in batch["operations"]):
                    ack["checkpoint"] = self.loaded_checkpoint
                await self.client.request("runtime.sync.ack", ack)
                self.on_progress = None
                expected += 1
                self.failures = 0
        finally:
            self.on_progress = None
            self.clear_snapshot()


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
