from __future__ import annotations

import asyncio
import pickle
import sys
import tempfile
from collections.abc import Mapping
from contextlib import ExitStack
from typing import Any

from connector.logging import logger
from connector.runtime_protocol.host import RuntimeHostClient
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


class SyncRelay:
    """Reassemble transport pages, then forward existing platform notifications.

    No native event parsing or backend-specific persistence protocol lives here.
    Live updates use the same Host publishers as the other runtimes, including
    their coalescing and WebSocket/HTTP fallback. Snapshots await HTTP ingestion.
    """

    def __init__(self, client: BridgeClient, host: RuntimeHostClient, *, retry_delay: float = 1.0) -> None:
        self.client, self.host = client, host
        self.queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(maxsize=2)
        self.stream_id: str | None = None
        self.retry_delay = retry_delay
        self.task: asyncio.Task[None] | None = None
        self.snapshot: dict[str, Any] | None = None
        self.file = None
        self.spool = ExitStack()
        self.items: list[dict[str, Any]] = []
        self.item_bytes = 0
        self.item_ids: set[str] = set()

    def start(self) -> None:
        self.task = asyncio.create_task(self.run(), name="dsh-event-sync")

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
        self.clear_snapshot()

    def clear_snapshot(self) -> None:
        self.spool.close()
        self.file, self.snapshot = None, None
        self.item_ids.clear()
        self.items = []
        self.item_bytes = 0

    async def operation(self, op: dict[str, Any]) -> None:
        kind = op.get("kind")
        if kind == "snapshot.begin":
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
                items = await self.load_items()
                meta = self.snapshot["meta"]
                # Reuse the existing complete snapshot API only after every page is received.
                await self.host.publish_runtime_notifications("dsh", [
                    {"method": "session.meta.upsert", "params": {"sessionId": op["sessionId"], **meta}},
                    {"method": "timeline.sync", "params": {"sessionId": op["sessionId"],
                        "externalSessionId": meta["externalSessionId"], "items": items, "complete": True}},
                ])
                self.clear_snapshot()
            else:
                self.clear_snapshot()
        elif kind == "notifications":
            for notice in op["notifications"]:
                await self.publish_notification(notice)
        elif kind == "workspace.inventory":
            # Older plugin builds sent native project facts. Ignore those batches;
            # all project grouping and naming use the existing session cwd path.
            return
        else:
            raise ValueError(f"Unsupported bridge operation: {kind}")

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

    async def load_items(self) -> list[dict[str, Any]]:
        if self.file is None:
            return self.items
        task = asyncio.create_task(asyncio.to_thread(self.read_spool))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            await task
            raise

    def read_spool(self) -> list[dict[str, Any]]:
        self.file.seek(0)
        items: list[dict[str, Any]] = []
        while True:
            try:
                items.extend(pickle.load(self.file))
            except EOFError:
                return items

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
            await self.host.publish_runtime_notifications("dsh", [notice])
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
                    logger.warning("DSH event sync interrupted; resubscribing for history calibration ({})", type(error).__name__)
                    if not self.client.connected:
                        return
                    self.clear_snapshot()
                    await asyncio.sleep(self.retry_delay)
                    while not self.queue.empty():
                        self.queue.get_nowait()
        finally:
            self.clear_snapshot()

    async def consume(self) -> None:
        # Subscription replaces only this feed. Concurrent RPC requests keep
        # their connection and are never cancelled by an ingest/sync failure.
        try:
            subscription = await self.client.request("runtime.sync.subscribe")
            if subscription.get("projectionVersion") != 2:
                raise ValueError("Unsupported DSH projection version")
            stream_id, expected = subscription["streamId"], 1
            self.stream_id = stream_id
            while True:
                batch = await self.queue.get()
                if batch is None:
                    raise RuntimeError("The DSH sync stream needs a new subscription")
                if batch.get("streamId") != stream_id:
                    continue
                if batch.get("batchSeq") != expected:
                    raise ValueError("Out-of-order event batch; reconnect to recalibrate")
                if batch.get("projectionVersion") != 2 or not isinstance(batch.get("operations"), list) or not batch["operations"]:
                    raise ValueError("Invalid DSH event batch")
                for operation in batch["operations"]:
                    await self.operation(operation)
                await self.client.request("runtime.sync.ack", {"streamId": stream_id, "batchSeq": expected})
                expected += 1
        finally:
            self.clear_snapshot()


def object_bytes(value: Any) -> int:
    """Conservative retained size for decoded JSON, without serializing it again."""
    if isinstance(value, dict):
        return sys.getsizeof(value) + sum(sys.getsizeof(key) + object_bytes(item) for key, item in value.items())
    if isinstance(value, list):
        return sys.getsizeof(value) + sum(object_bytes(item) for item in value)
    return sys.getsizeof(value)
