"""Connector-owned durable runtime logs, shared by local RPC clients."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Annotated, Any, Literal

from meshcall import mutates, query, service, stream
from pydantic import BaseModel, Field

from connector.core.runtime_logs import RuntimeLogStore
from connector.logging import logger
from connector.mesh.hub import LOGS_SERVICE
from connector.mesh.log_redaction import redact

Source = Literal["connector", "bridge"]


class LogRecord(BaseModel):
    time: str = Field(max_length=80)
    level: str = Field(max_length=20)
    name: str = Field(max_length=200)
    message: str = Field(max_length=16000)
    exception: str | None = Field(default=None, max_length=16000)
    details: str | None = Field(default=None, max_length=16000)


class LogWrite(LogRecord):
    producer: str = Field(min_length=1, max_length=128)
    eventId: str = Field(min_length=1, max_length=128)


class LogEntry(LogRecord):
    seq: int
    source: Source = "connector"
    gapBefore: bool = False


class LogPage(BaseModel):
    items: list[LogEntry]
    firstSeq: int | None
    lastSeq: int | None
    total: int
    hasMoreBefore: bool
    hasMoreAfter: bool


class LogReceipt(BaseModel):
    accepted: int


class LogHub:
    def __init__(self, directory: Path | None = None, **policy: Any) -> None:
        self.store = RuntimeLogStore(directory, **policy)

    def append(self, records: list[LogRecord], source: Source, *, durable: bool = True) -> int:
        rows = []
        for record in records:
            payload = record.model_dump(exclude={"producer", "eventId"})
            payload = {key: redact(value) if isinstance(value, str) else value for key, value in payload.items()}
            rows.append({"source": source, "record": payload,
                         "producer": getattr(record, "producer", None), "eventId": getattr(record, "eventId", None)})
        return self.store.append(rows, durable=durable)

    def notify(self, _method: str, payload: dict[str, Any]) -> None:
        # Connector records are not acknowledged to anyone, so they skip fsync;
        # an acknowledged bridge batch always goes through LogsService.write.
        self.append([LogRecord.model_validate(payload)], "connector", durable=False)

    def read(self, source: Source | None = None, beforeSeq: int | None = None,
             afterSeq: int | None = None, limit: int = 200) -> LogPage:
        rows = [row for row in self.store.rows() if source is None or row["source"] == source]
        selected = [row for row in rows if (beforeSeq is None or row["seq"] < beforeSeq)
                    and (afterSeq is None or row["seq"] > afterSeq)]
        selected = selected[:limit] if afterSeq is not None else selected[-limit:]
        items = [LogEntry(seq=row["seq"], source=row["source"], **row["record"]) for row in selected]
        first, last = (rows[0]["seq"], rows[-1]["seq"]) if rows else (None, None)
        return LogPage(items=items, firstSeq=first, lastSeq=last, total=len(rows),
                       hasMoreBefore=bool(items and first < items[0].seq),
                       hasMoreAfter=bool(items and last > items[-1].seq))

    def clear(self) -> LogPage:
        self.store.clear()
        return self.read()

    def close(self) -> None:
        self.store.close()


def open_log_hub(directory: Path | None) -> LogHub:
    """Open the durable journal, degrading to memory when it cannot be used.

    Runtime logging is auxiliary: a damaged or unwritable log directory must
    not prevent the Connector from serving sessions.
    """
    try:
        return LogHub(directory)
    except Exception as error:  # noqa: BLE001 - logging never blocks startup
        logger.warning("runtime log store unavailable; keeping logs in memory error_type={} error={}",
                       type(error).__name__, error)
        return LogHub(None)


@service(LOGS_SERVICE, description="Write, read and follow Connector-owned persistent runtime logs.")
class LogsService:
    def __init__(self, logs: LogHub) -> None:
        self._logs = logs

    @mutates
    async def write(self, entries: Annotated[list[LogWrite], Field(max_length=64)]) -> LogReceipt:
        """Commit a Bridge batch; stable producer/eventId pairs deduplicate retries."""
        return LogReceipt(accepted=await asyncio.to_thread(self._logs.append, entries, "bridge"))

    @query
    async def read(self, source: Source | None = None, beforeSeq: int | None = None,
                   afterSeq: int | None = None, limit: Annotated[int, Field(ge=1, le=1000)] = 200) -> LogPage:
        """Read a bounded page of persisted runtime records."""
        return await asyncio.to_thread(self._logs.read, source, beforeSeq, afterSeq, limit)

    @mutates
    async def clear(self) -> LogPage:
        """Clear runtime records without resetting their sequence; host only."""
        return await asyncio.to_thread(self._logs.clear)

    @stream
    async def tail(self, since: int | None = None, source: Source | None = None) -> AsyncIterator[LogEntry]:
        """Replay persisted history then follow new records, marking retention gaps."""
        cursor = since
        while True:
            page = await asyncio.to_thread(self._logs.read, source, None, cursor)
            oldest = (await asyncio.to_thread(self._logs.store.first_seq) if source else page.firstSeq)
            for index, item in enumerate(page.items):
                if index == 0 and cursor is not None and oldest is not None and cursor < oldest - 1:
                    item.gapBefore = True
                cursor = item.seq
                yield item
            if page.hasMoreAfter:
                continue
            if not await asyncio.to_thread(self._logs.store.wait):
                return
