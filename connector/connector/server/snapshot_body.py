from __future__ import annotations

import hashlib
import json
import tempfile
from collections.abc import Iterable, Iterator
from typing import Any, BinaryIO

from connector.core.unicode import UTF8_REPLACE_LONE_SURROGATES
from connector.server.runtime_rpc_payloads import server_payload_without_turn_data

# Snapshots up to this size go out as one request, which replaces the timeline
# atomically; larger ones are cut into pages at item boundaries. It stays under
# the cluster proxy's 50 MiB request limit.
SNAPSHOT_PAGE_BYTES = 45 * 1024 * 1024
# The page size 2.1.0 used and every deployment accepted. A larger page that
# cannot be delivered is cut down to it.
SNAPSHOT_LEGACY_PAGE_BYTES = 8 * 1024 * 1024
# A proxy that answers 413 halves the page size, down to this floor.
SNAPSHOT_MIN_PAGE_BYTES = 1024 * 1024

_OPEN = b'{"notifications":['
_CLOSE = b"]}}]}"


class EncodedSnapshot:
    """A complete snapshot with every item encoded once into a temporary file.

    Items are stored comma-separated, so a page is one contiguous range of the
    file between a prefix and the closing bytes. Pages are cut on demand: a page
    size learned during the upload re-cuts the remaining items without encoding
    them again.

    The first page carries the session meta and replaces the whole timeline
    (``complete: true``); later pages append the remaining items
    (``complete: false``). Items arrive sorted by ``orderSeq`` and the Server
    keeps the ``orderSeq`` of a new item that sorts after everything it already
    holds, so appending them in order rebuilds the timeline the single request
    would have. Close it when the upload ends.
    """

    def __init__(self, file: BinaryIO, ends: list[int], first_prefix: bytes, later_prefix: bytes) -> None:
        self._file = file
        # Item i ends at ends[i]; the next one starts after its comma.
        self._ends = ends
        self._first_prefix = first_prefix
        self._later_prefix = later_prefix

    def __len__(self) -> int:
        return len(self._ends)

    @property
    def closed(self) -> bool:
        return self._file.closed

    def __enter__(self) -> EncodedSnapshot:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._file.close()

    def page_end(self, start: int, page_bytes: int | None, *, first: bool) -> int:
        """End of the page that begins at item ``start``: what fits in ``page_bytes``, at least one item.

        ``None`` never splits.
        """

        if page_bytes is None:
            return len(self._ends)
        overhead = len(self._prefix(first)) + len(_CLOSE)
        offset = self._start(start)
        end = start
        while end < len(self._ends) and (end == start or overhead + self._ends[end] - offset <= page_bytes):
            end += 1
        return end

    def page_size(self, start: int, end: int, *, first: bool) -> int:
        items = self._ends[end - 1] - self._start(start) if end > start else 0
        return len(self._prefix(first)) + items + len(_CLOSE)

    def page_chunks(self, start: int, end: int, *, first: bool, chunk_bytes: int) -> Iterator[bytes]:
        """The request body of items ``start:end``, read from the file in chunks; repeatable."""

        yield self._prefix(first)
        if end > start:
            self._file.seek(self._start(start))
            remaining = self._ends[end - 1] - self._start(start)
            while remaining:
                chunk = self._file.read(min(chunk_bytes, remaining))
                if not chunk:
                    raise OSError("The encoded snapshot ended early")
                remaining -= len(chunk)
                yield chunk
        yield _CLOSE

    def _prefix(self, first: bool) -> bytes:
        return self._first_prefix if first else self._later_prefix

    def _start(self, index: int) -> int:
        return self._ends[index - 1] + 1 if index else 0


def encode_snapshot(
    runtime: str, runtime_id: str, session_id: str,
    meta: dict[str, Any], items: Iterable[dict[str, Any]],
) -> EncodedSnapshot:
    """Encode a complete snapshot for ``/connector/ingest``, one item at a time."""

    encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False, sort_keys=True)
    binding = {"runtime": runtime, "runtimeId": runtime_id, "sessionId": session_id}

    def encode(value: Any) -> bytes:
        return "".join(encoder.iterencode(server_payload_without_turn_data(value))).encode("utf-8", UTF8_REPLACE_LONE_SURROGATES)

    def sync_head(complete: bool) -> bytes:
        head = encode({"method": "timeline.sync", "params": {
            **binding, "externalSessionId": meta["externalSessionId"], "complete": complete,
        }})
        # Leave the params object open; the items follow.
        return head[:-2] + b',"items":['

    first_prefix = _OPEN + encode({"method": "session.meta.upsert", "params": {**meta, **binding}}) + b"," + sync_head(True)
    later_prefix = _OPEN + sync_head(False)
    file = tempfile.TemporaryFile(mode="w+b")  # noqa: SIM115 - ownership transfers to the snapshot
    try:
        ends: list[int] = []
        for item in items:
            if ends:
                file.write(b",")
            file.write(encode(item))
            ends.append(file.tell())
    except BaseException:
        file.close()
        raise
    return EncodedSnapshot(file, ends, first_prefix, later_prefix)


def snapshot_body(
    runtime: str, runtime_id: str, session_id: str,
    meta: dict[str, Any], items: Iterable[dict[str, Any]],
) -> BinaryIO:
    """The whole snapshot as one request body, positioned at 0; the caller closes it."""

    with encode_snapshot(runtime, runtime_id, session_id, meta, items) as snapshot:
        body = tempfile.TemporaryFile(mode="w+b")  # noqa: SIM115 - ownership transfers to the caller
        try:
            for chunk in snapshot.page_chunks(0, len(snapshot), first=True, chunk_bytes=64 * 1024):
                body.write(chunk)
        except BaseException:
            body.close()
            raise
    body.seek(0)
    return body


def body_digest(body: BinaryIO) -> tuple[str, int]:
    body.seek(0)
    digest = hashlib.sha256()
    size = 0
    while chunk := body.read(64 * 1024):
        digest.update(chunk)
        size += len(chunk)
    body.seek(0)
    return digest.hexdigest(), size
