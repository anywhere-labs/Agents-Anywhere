from __future__ import annotations

import asyncio
import json
import tempfile
from collections.abc import Mapping
from typing import Any

from connector.logging import logger
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.dsh.bridge.client import BridgeClient
from connector.runtimes.dsh.bridge.models import capability_set, notice as session_notice, timeline_item


class SyncRelay:
    """Reassemble transport pages, then forward existing platform notifications.

    No native event parsing or backend-specific persistence protocol lives here.
    A failed/ambiguous HTTP request reconnects and recalibrates complete history.
    """

    def __init__(self, client: BridgeClient, host: RuntimeHostClient) -> None:
        self.client, self.host = client, host
        self.queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=2)
        self.task: asyncio.Task[None] | None = None
        self.snapshot: dict[str, Any] | None = None
        self.file = None
        self.item_ids: set[str] = set()

    def start(self) -> None:
        self.task = asyncio.create_task(self.run(), name="dsh-event-sync")

    def accept(self, payload: Mapping[str, Any]) -> None:
        self.queue.put_nowait(dict(payload))

    async def close(self) -> None:
        if self.task and self.task is not asyncio.current_task():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        self.clear_snapshot()

    def clear_snapshot(self) -> None:
        if self.file:
            self.file.close()
        self.file, self.snapshot = None, None
        self.item_ids.clear()

    async def operation(self, op: dict[str, Any]) -> None:
        kind = op.get("kind")
        if kind == "snapshot.begin":
            self.clear_snapshot()
            self.snapshot = op
            self.file = tempfile.TemporaryFile(mode="w+t", encoding="utf-8")
        elif kind in {"snapshot.items", "snapshot.commit", "snapshot.abort"}:
            if not self.snapshot or any(op.get(k) != self.snapshot.get(k) for k in ("snapshotId", "sessionId")):
                raise ValueError("Snapshot page has a different capture identity")
            if kind == "snapshot.items":
                for raw in op["items"]:
                    item = timeline_item(raw)
                    if item.session_id != op["sessionId"] or item.id in self.item_ids:
                        raise ValueError("Invalid snapshot item identity")
                    self.item_ids.add(item.id)
                    self.file.write(json.dumps(raw, ensure_ascii=False) + "\n")
            elif kind == "snapshot.commit":
                if len(self.item_ids) != op.get("totalItems") or op.get("throughSeq") != self.snapshot["throughSeq"]:
                    raise ValueError("Incomplete snapshot; previous backend history remains intact")
                self.file.seek(0)
                items = [json.loads(line) for line in self.file]
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
            pending = []

            async def publish_pending():
                if pending:
                    await self.host.publish_runtime_notifications("dsh", list(pending))
                    pending.clear()

            for notice in op["notifications"]:
                # Use the platform's existing interaction/capability publishers.
                # Its synchronous history publisher intentionally accepts only history.
                if notice.get("method") == "notice.upsert":
                    await publish_pending()
                    await self.host.notice_upsert(session_notice(notice["params"]))
                    continue
                if notice.get("method") == "runtime.capability.updated":
                    await publish_pending()
                    await self.host.runtime_capabilities_update(capability_set(
                        notice["params"], connector_id=self.host.connector_id,
                    ))
                    continue
                if notice.get("method") == "timeline.itemUpsert":
                    item = timeline_item(notice["params"]["item"])
                    if item.session_id != notice["params"].get("sessionId"):
                        raise ValueError("Incremental item belongs to a different session")
                pending.append(notice)
            # The Host binds connector/runtime identity and uses /connector/ingest.
            # Returning here means accepted by that existing path, not a new DB ACK contract.
            await publish_pending()
        elif kind == "workspace.inventory":
            # Older plugin builds sent native project facts. Ignore those batches;
            # all project grouping and naming use the existing session cwd path.
            return
        else:
            raise ValueError(f"Unsupported bridge operation: {kind}")

    async def run(self) -> None:
        try:
            subscription = await self.client.request("runtime.sync.subscribe")
            if subscription.get("projectionVersion") != 2:
                raise ValueError("Unsupported DSH projection version")
            stream_id, expected = subscription["streamId"], 1
            while True:
                batch = await self.queue.get()
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
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Do not log native content, request bodies or local credentials.
            logger.warning("DSH event sync interrupted; reconnecting for complete history calibration ({})", type(error).__name__)
            if self.client.writer is not None:
                self.client.writer.close()
        finally:
            self.clear_snapshot()
