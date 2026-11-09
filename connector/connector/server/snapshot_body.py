from __future__ import annotations

import hashlib
import json
import tempfile
from collections.abc import Callable, Iterable, Iterator
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
_CLOSE_ITEMS = b"]}}"
_CLOSE = _CLOSE_ITEMS + b"]}"
# The Server stores orderSeq as a 32-bit integer.
_ORDER_SEQ_MIN = -(2**31)


class EncodedSnapshot:
    """A complete snapshot with every item encoded once into a temporary file.

    Items are stored comma-separated, so a page is one contiguous range of the
    file between a prefix and the closing bytes. Pages are cut on demand: a page
    size learned during the upload re-cuts the remaining items without encoding
    them again.

    A snapshot that fits one page replaces the whole timeline
    (``complete: true``). When it is paged, the first page also carries the
    session meta and ``complete: true``, later pages ``complete: false``, and
    every page names the ``orderSeq`` range it covers in ``snapshotRange``:
    items arrive sorted by ``orderSeq``, so page *k* holds every item in
    ``(highest orderSeq before it, highest orderSeq through it]``, unbounded
    below on the first page and above on the last. The Server replaces only
    that range, so each page is applied on its own and unchanged history is
    not rewritten. A Server that does not know ``snapshotRange`` replaces the
    timeline with the first page and appends the rest, which rebuilds the
    timeline the single request would have. Items without an integer
    ``orderSeq`` turn ranges off for the whole snapshot.

    A partial snapshot (``complete: false`` from the start) only adds items:
    every page is ``complete: false`` and carries no range, since a range
    would delete the history the snapshot leaves out. Notifications that have
    to follow the items, such as the session state, ride on the last page.
    Close it when the upload ends.
    """

    def __init__(
        self,
        file: BinaryIO,
        ends: list[int],
        meta_prefix: bytes,
        sync_head: Callable[[bool, dict[str, int] | None], bytes],
        through_order_seqs: list[int] | None,
        trailing: bytes = b"",
    ) -> None:
        self._file = file
        # Item i ends at ends[i]; the next one starts after its comma.
        self._ends = ends
        self._meta_prefix = meta_prefix
        self._sync_head = sync_head
        # Highest orderSeq among items 0..i, or None when ranges are off.
        self._through = through_order_seqs
        self._last_close = _CLOSE_ITEMS + b"," + trailing + b"]}" if trailing else _CLOSE
        # The longest range header, so a page cut before its range is known
        # never outgrows the page size.
        widest = {"afterOrderSeq": _ORDER_SEQ_MIN, "throughOrderSeq": _ORDER_SEQ_MIN}
        self._widest_prefix_bytes = {
            first: len(self._prefix_for(first, widest if through_order_seqs is not None else None))
            for first in (True, False)
        }

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
        prefix = self._widest_prefix_bytes[first]
        offset = self._start(start)
        end = start
        while end < len(self._ends) and (
            end == start or prefix + self._ends[end] - offset + len(self._close(end + 1)) <= page_bytes
        ):
            end += 1
        return end

    def page_range(self, start: int, end: int, *, first: bool) -> dict[str, int] | None:
        """The ``snapshotRange`` of items ``start:end``; ``None`` for a single-page snapshot."""

        if self._through is None or (first and end >= len(self._ends)):
            return None
        bounds: dict[str, int] = {}
        if not first and start > 0:
            bounds["afterOrderSeq"] = self._through[start - 1]
        if end < len(self._ends):
            bounds["throughOrderSeq"] = self._through[end - 1]
        return bounds

    def page_size(self, start: int, end: int, *, first: bool) -> int:
        items = self._ends[end - 1] - self._start(start) if end > start else 0
        return len(self._prefix(start, end, first)) + items + len(self._close(end))

    def page_chunks(self, start: int, end: int, *, first: bool, chunk_bytes: int) -> Iterator[bytes]:
        """The request body of items ``start:end``, read from the file in chunks; repeatable."""

        yield self._prefix(start, end, first)
        if end > start:
            self._file.seek(self._start(start))
            remaining = self._ends[end - 1] - self._start(start)
            while remaining:
                chunk = self._file.read(min(chunk_bytes, remaining))
                if not chunk:
                    raise OSError("The encoded snapshot ended early")
                remaining -= len(chunk)
                yield chunk
        yield self._close(end)

    def _prefix(self, start: int, end: int, first: bool) -> bytes:
        return self._prefix_for(first, self.page_range(start, end, first=first))

    def _prefix_for(self, first: bool, snapshot_range: dict[str, int] | None) -> bytes:
        head = self._sync_head(first, snapshot_range)
        return (self._meta_prefix if first else _OPEN) + head

    def _close(self, end: int) -> bytes:
        return self._last_close if end >= len(self._ends) else _CLOSE

    def _start(self, index: int) -> int:
        return self._ends[index - 1] + 1 if index else 0


def encode_snapshot(
    runtime: str, runtime_id: str, session_id: str,
    meta: dict[str, Any], items: Iterable[dict[str, Any]],
    *, complete: bool = True, trailing: Iterable[dict[str, Any]] = (),
) -> EncodedSnapshot:
    """Encode a snapshot for ``/connector/ingest``, one item at a time.

    ``complete`` says whether the first page replaces the timeline. The
    ``trailing`` notifications are sent as given after the last item.
    """

    encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False, sort_keys=True)
    binding = {"runtime": runtime, "runtimeId": runtime_id, "sessionId": session_id}

    def encode(value: Any) -> bytes:
        return "".join(encoder.iterencode(server_payload_without_turn_data(value))).encode("utf-8", UTF8_REPLACE_LONE_SURROGATES)

    def sync_head(first: bool, snapshot_range: dict[str, int] | None) -> bytes:
        params: dict[str, Any] = {
            **binding, "externalSessionId": meta["externalSessionId"], "complete": first and complete,
        }
        if snapshot_range is not None:
            params["snapshotRange"] = snapshot_range
        head = encode({"method": "timeline.sync", "params": params})
        # Leave the params object open; the items follow.
        return head[:-2] + b',"items":['

    meta_prefix = _OPEN + encode({"method": "session.meta.upsert", "params": {**meta, **binding}}) + b","
    trailing_body = b",".join(
        json.dumps(notification, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
            "utf-8", UTF8_REPLACE_LONE_SURROGATES,
        )
        for notification in trailing
    )
    file = tempfile.TemporaryFile(mode="w+b")  # noqa: SIM115 - ownership transfers to the snapshot
    try:
        ends: list[int] = []
        # A partial snapshot never names a range; see EncodedSnapshot.
        through: list[int] | None = [] if complete else None
        for item in items:
            if ends:
                file.write(b",")
            file.write(encode(item))
            ends.append(file.tell())
            if through is not None:
                order_seq = item.get("orderSeq")
                if isinstance(order_seq, bool) or not isinstance(order_seq, int):
                    through = None
                else:
                    through.append(max(order_seq, through[-1]) if through else order_seq)
    except BaseException:
        file.close()
        raise
    return EncodedSnapshot(file, ends, meta_prefix, sync_head, through, trailing_body)


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
