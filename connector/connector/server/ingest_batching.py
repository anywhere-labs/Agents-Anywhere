"""Byte-bounded HTTP ingest encoding without changing snapshot semantics.

Only incremental timeline.sync may be split at item boundaries. A complete
snapshot is a replacement, NOT a final-page marker, so it always travels whole
in its own request even when that request exceeds the page budget; only the
server (HTTP 413) decides that it is too large. Iteration is CPU work and must
happen off the connector's event-loop thread.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

MAX_INGEST_BODY_BYTES = 8 * 1024 * 1024
_BODY_PREFIX = b'{"notifications":['
_BODY_SUFFIX = b']}'
_ENVELOPE_BYTES = len(_BODY_PREFIX) + len(_BODY_SUFFIX)
_ENCODER = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class ConnectorIngestSizeError(RuntimeError):
    """A permanent size rejection; text contains no notification or server data.

    size_bytes is the size of the rejected request body, not necessarily the
    size of the entire source snapshot.
    """

    def __init__(self, size_bytes: int, limit_bytes: int, reason: str) -> None:
        self.size_bytes = size_bytes
        self.limit_bytes = limit_bytes
        self.reason = reason
        super().__init__(
            f"ingest size rejected reason={reason} observed_bytes={size_bytes} "
            f"limit_bytes={limit_bytes}"
        )


@dataclass(frozen=True)
class IngestFragment:
    """One whole notification, or a run of items from an incremental sync.

    ``after`` is the delivery position once this fragment is accepted:
    ``(notification index, items already delivered from that notification)``.
    """

    data: bytes
    method: str
    after: tuple[int, int]


@dataclass(frozen=True)
class IngestPage:
    fragments: tuple[IngestFragment, ...]
    # Marks the last HTTP page internally; it never changes a timeline
    # notification's complete flag. It avoids yielding after final acceptance.
    last: bool

    @property
    def body(self) -> bytes:
        return ingest_body(fragment.data for fragment in self.fragments)

    @property
    def after(self) -> tuple[int, int]:
        return self.fragments[-1].after


def ingest_body(parts: Any) -> bytes:
    return _BODY_PREFIX + b",".join(parts) + _BODY_SUFFIX


def _encode_json(value: Any) -> bytes:
    # One-shot encode() uses the C encoder; iterencode() never does.
    return _ENCODER.encode(value).encode("utf-8")


def _notification_fragments(
    index: int, notification: dict[str, Any], budget: int,
) -> Iterator[IngestFragment]:
    method = str(notification.get("method"))
    params = notification.get("params")
    if (method != "timeline.sync"
            or not isinstance(params, dict)
            or params.get("complete") is True
            or not isinstance(params.get("items"), list)
            or not params["items"]):
        # An explicitly empty timeline is a meaningful notification, not a no-op.
        yield IngestFragment(_encode_json(notification), method, (index + 1, 0))
        return

    outer = {k: v for k, v in notification.items() if k != "params"}
    metadata = {k: v for k, v in params.items() if k != "items"}
    outer_bytes = _encode_json(outer)
    metadata_bytes = _encode_json(metadata)
    prefix = (outer_bytes[:-1] + (b"," if outer else b"") + b'"params":'
              + metadata_bytes[:-1] + (b"," if metadata else b"") + b'"items":[')
    suffix = b"]}}"
    overhead = len(prefix) + len(suffix)
    items = params["items"]
    parts: list[bytes] = []
    size = overhead
    for position, item in enumerate(items):
        encoded = _encode_json(item)
        added = len(encoded) + bool(parts)
        if parts and size + added > budget:
            yield IngestFragment(prefix + b",".join(parts) + suffix, method, (index, position))
            parts = []
            size = overhead
        # A single item larger than the budget still travels whole, alone.
        size += len(encoded) + bool(parts)
        parts.append(encoded)
    yield IngestFragment(prefix + b",".join(parts) + suffix, method, (index + 1, 0))


def iter_ingest_pages(
    notifications: list[dict[str, Any]], max_bytes: int = MAX_INGEST_BODY_BYTES,
) -> Iterator[IngestPage]:
    if max_bytes < _ENVELOPE_BYTES:
        raise ValueError("ingest body budget is smaller than its JSON envelope")
    budget = max_bytes - _ENVELOPE_BYTES
    fragments: list[IngestFragment] = []
    size = _ENVELOPE_BYTES
    for index, notification in enumerate(notifications):
        for fragment in _notification_fragments(index, notification, budget):
            added = len(fragment.data) + bool(fragments)
            if fragments and size + added > max_bytes:
                yield IngestPage(tuple(fragments), last=False)
                fragments = []
                size = _ENVELOPE_BYTES
            size += len(fragment.data) + bool(fragments)
            fragments.append(fragment)
    if fragments:
        yield IngestPage(tuple(fragments), last=True)


def next_ingest_page(pages: Iterator[IngestPage]) -> IngestPage | None:
    # StopIteration must not escape through an asyncio Future.
    return next(pages, None)


def drop_delivered(notifications: list[dict[str, Any]], position: tuple[int, int]) -> None:
    """Remove everything before ``position`` so a retry resumes there."""
    index, delivered_items = position
    del notifications[:index]
    if delivered_items and notifications:
        head = notifications[0]
        params = head["params"]
        # Incremental items are upserts by ID; only the undelivered tail remains.
        notifications[0] = {**head, "params": {**params, "items": params["items"][delivered_items:]}}
