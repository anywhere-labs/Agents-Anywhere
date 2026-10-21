from __future__ import annotations

import hashlib
import json
import tempfile
from collections.abc import Iterable
from typing import Any, BinaryIO

from connector.core.unicode import UTF8_REPLACE_LONE_SURROGATES
from connector.server.runtime_rpc_payloads import server_payload_without_turn_data

# A complete snapshot larger than this is split into pages at item boundaries,
# so no single request body has to clear a proxy's size limit.
SNAPSHOT_PAGE_BYTES = 8 * 1024 * 1024


def snapshot_pages(
    runtime: str, runtime_id: str, session_id: str,
    meta: dict[str, Any], items: Iterable[dict[str, Any]], *, page_bytes: int | None = SNAPSHOT_PAGE_BYTES,
) -> list[BinaryIO]:
    """Encode a complete snapshot into one or more ``/connector/ingest`` bodies.

    The first page carries the session meta and replaces the whole timeline
    (``complete: true``); later pages append the remaining items
    (``complete: false``). Items arrive sorted by ``orderSeq`` and the Server
    keeps the ``orderSeq`` of a new item that sorts after everything it already
    holds, so appending them in order rebuilds the timeline the single request
    would have. A page is closed once the next item would push it past
    ``page_bytes``; ``None`` never splits. Every page is a seekable temporary
    file positioned at 0; the caller closes them.
    """

    encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False, sort_keys=True)
    binding = {"runtime": runtime, "runtimeId": runtime_id, "sessionId": session_id}
    pages: list[BinaryIO] = []

    def encode(value: Any) -> bytes:
        return "".join(encoder.iterencode(server_payload_without_turn_data(value))).encode("utf-8", UTF8_REPLACE_LONE_SURROGATES)

    def open_page(first: bool) -> BinaryIO:
        body = tempfile.TemporaryFile(mode="w+b")  # noqa: SIM115 - ownership transfers to the uploader
        try:
            body.write(b'{"notifications":[')
            if first:
                body.write(encode({"method": "session.meta.upsert", "params": {**meta, **binding}}))
                body.write(b",")
            head = encode({"method": "timeline.sync", "params": {
                **binding, "externalSessionId": meta["externalSessionId"], "complete": first,
            }})
            # Leave the params object open to stream the items one at a time.
            body.write(head[:-2] + b',"items":[')
        except BaseException:
            body.close()
            raise
        return body

    def close_page(body: BinaryIO) -> None:
        body.write(b"]}}]}")
        body.seek(0)
        pages.append(body)

    body = open_page(first=True)
    count = 0
    try:
        for item in items:
            encoded = encode(item)
            if page_bytes is not None and count and body.tell() + len(encoded) + len(b",]}}]}") > page_bytes:
                close_page(body)
                body = open_page(first=False)
                count = 0
            if count:
                body.write(b",")
            body.write(encoded)
            count += 1
        close_page(body)
    except BaseException:
        if body not in pages:
            body.close()
        for page in pages:
            page.close()
        raise
    return pages


def snapshot_body(
    runtime: str, runtime_id: str, session_id: str,
    meta: dict[str, Any], items: Iterable[dict[str, Any]],
) -> BinaryIO:
    """The whole snapshot as one request body."""

    return snapshot_pages(runtime, runtime_id, session_id, meta, items, page_bytes=None)[0]


def body_digest(body: BinaryIO) -> tuple[str, int]:
    body.seek(0)
    digest = hashlib.sha256()
    size = 0
    while chunk := body.read(64 * 1024):
        digest.update(chunk)
        size += len(chunk)
    body.seek(0)
    return digest.hexdigest(), size
