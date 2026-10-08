"""Byte-bounded HTTP ingest encoding without changing snapshot semantics.

Only incremental timeline.sync may be split at item boundaries. A complete
snapshot is a replacement, NOT a final-page marker. Iteration is CPU work and
must happen off the connector's event-loop thread.
"""
from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

MAX_INGEST_BODY_BYTES = 8 * 1024 * 1024
_BODY_PREFIX = b'{"notifications":['
_BODY_SUFFIX = b']}'
_ENCODER = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False)


class ConnectorIngestSizeError(RuntimeError):
    """A permanent size rejection; text contains no notification or server data.

    size_bytes is the observed byte count (a lower bound for encoding that was
    stopped early), not necessarily the size of the entire source snapshot.
    """

    def __init__(self, size_bytes: int, limit_bytes: int, reason: str) -> None:
        self.size_bytes = size_bytes
        self.limit_bytes = limit_bytes
        self.reason = reason
        super().__init__(
            f"ingest size rejected reason={reason} observed_bytes={size_bytes} "
            f"limit_bytes={limit_bytes}"
        )


def _encode_json(value: Any, limit: int, reason: str) -> bytes:
    parts: list[bytes] = []
    size = 0
    for part in _ENCODER.iterencode(value):
        encoded = part.encode("utf-8")
        size += len(encoded)
        if size > limit:
            raise ConnectorIngestSizeError(size, limit, reason)
        parts.append(encoded)
    return b"".join(parts)


def _notification_pages(notification: dict[str, Any], limit: int) -> Iterator[bytes]:
    params = notification.get("params")
    if (notification.get("method") != "timeline.sync"
            or not isinstance(params, dict)
            or params.get("complete") is True
            or not isinstance(params.get("items"), list)):
        yield _encode_json(notification, limit, "atomic_notification")
        return

    outer = {k: v for k, v in notification.items() if k != "params"}
    metadata = {k: v for k, v in params.items() if k != "items"}
    outer_bytes = _encode_json(outer, limit, "timeline_metadata")
    metadata_bytes = _encode_json(metadata, limit, "timeline_metadata")
    prefix = (outer_bytes[:-1] + (b"," if outer else b"") + b'"params":'
              + metadata_bytes[:-1] + (b"," if metadata else b"") + b'"items":[')
    suffix = b"]}}"
    overhead = len(prefix) + len(suffix)
    if overhead > limit:
        raise ConnectorIngestSizeError(overhead, limit, "timeline_metadata")
    parts: list[bytes] = []
    size = overhead
    for item in params["items"]:
        encoded = _encode_json(item, limit - overhead, "timeline_item")
        added = len(encoded) + bool(parts)
        if parts and size + added > limit:
            yield prefix + b",".join(parts) + suffix
            parts = []
            size = overhead
        size += len(encoded) + bool(parts)
        parts.append(encoded)
    # An explicitly empty timeline is a meaningful notification, not a no-op.
    yield prefix + b",".join(parts) + suffix


def iter_ingest_batches(
    notifications: list[dict[str, Any]], max_bytes: int = MAX_INGEST_BODY_BYTES,
) -> Iterator[tuple[bytes, bool]]:
    # The bool marks the last HTTP page internally; it never changes a timeline
    # notification's complete flag. It avoids yielding after final acceptance.
    envelope_size = len(_BODY_PREFIX) + len(_BODY_SUFFIX)
    if max_bytes < envelope_size:
        raise ValueError("ingest body budget is smaller than its JSON envelope")
    parts: list[bytes] = []
    size = envelope_size
    for notification in notifications:
        for encoded in _notification_pages(notification, max_bytes - envelope_size):
            added = len(encoded) + bool(parts)
            if parts and size + added > max_bytes:
                yield _BODY_PREFIX + b",".join(parts) + _BODY_SUFFIX, False
                parts = []
                size = envelope_size
            size += len(encoded) + bool(parts)
            parts.append(encoded)
    if parts:
        yield _BODY_PREFIX + b",".join(parts) + _BODY_SUFFIX, True


def next_ingest_batch(pages: Iterator[tuple[bytes, bool]]) -> tuple[bytes, bool] | None:
    # StopIteration must not escape through an asyncio Future.
    return next(pages, None)
