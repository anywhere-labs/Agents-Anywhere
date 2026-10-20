"""Keep one timeline notification inside the backend frame budget.

A single ``timeline.itemUpsert`` must fit in ``CONNECTOR_WS_MAX_NOTIFICATION_BYTES``
(900 KiB). Anything unbounded can push it over: a tool dumping a whole file, a
vendor diff in an artifact patch, an agent prompt, or an attachment inlined by
the runtime as a ``data:`` URL. When the frame was refused the item never
reached the platform and the turn ended with no visible cause.

Two layers, because neither alone is enough:

- :func:`bound_content_field` bounds the fields known to be large at the point
  they are built, so ordinary oversize content is trimmed with a notice instead
  of being mangled by a generic pass.
- :func:`bound_payload` is the backstop applied where the frame is actually
  measured, so a field nobody thought about still cannot exceed the budget. It
  protects every runtime and every content type, including ones added later.

Oversize strings are kept head-first, because the beginning of a result is the
part a reader acts on.
"""

from __future__ import annotations

import json
from typing import Any

# Leaves room for the rest of the item envelope (ids, source, metadata) plus the
# JSON escaping of the kept text.
MAX_TIMELINE_TEXT_BYTES = 256 * 1024
TRUNCATION_NOTICE = "\n\n[内容过大，已截断；完整输出未在时间线中传输]"


def _utf8_len(value: str) -> int:
    return len(value.encode("utf-8"))


def _truncate_text(value: str, max_bytes: int) -> str:
    if _utf8_len(value) <= max_bytes:
        return value
    budget = max(max_bytes - _utf8_len(TRUNCATION_NOTICE), 0)
    if budget <= 0:
        return TRUNCATION_NOTICE.strip()
    encoded = value.encode("utf-8")[:budget]
    # A multi-byte character split by the cut is not valid UTF-8 on its own.
    cut = encoded.decode("utf-8", errors="ignore")
    # JSON escaping grows the payload again (quotes, backslashes, control
    # characters cost up to 6 bytes each), so measure the encoded form and keep
    # trimming until the serialized result really fits.
    while cut and len(json.dumps(cut + TRUNCATION_NOTICE, ensure_ascii=False).encode("utf-8")) > max_bytes:
        cut = cut[: max(len(cut) - 4096, len(cut) // 2)]
    return cut + TRUNCATION_NOTICE


def _shrink(value: Any, max_bytes: int) -> Any:
    """Recursively bound ``value``'s serialized size, preserving its shape."""

    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _truncate_text(value, max_bytes)
    if isinstance(value, dict):
        # Spread the budget over the keys, so no single oversized entry wins.
        share = max(max_bytes // max(len(value), 1), 1024)
        return {key: _shrink(item, share) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        share = max(max_bytes // max(len(value), 1), 1024)
        return [_shrink(item, share) for item in value]
    return _shrink(str(value), max_bytes)


def bound_content_field(field: Any, max_bytes: int = MAX_TIMELINE_TEXT_BYTES) -> Any:
    """Return ``field`` unchanged when small enough, else a bounded copy.

    ``max_bytes`` bounds the *serialized* size, because that is what the frame
    budget measures; JSON escaping can inflate a string well past its own
    length.
    """

    if field is None:
        return None
    if _serialized_size(field) <= max_bytes:
        return field
    bounded = _shrink(field, max_bytes)
    # Structure shrinking spreads the budget; a wide container can still land a
    # little over, so finish with one flat pass.
    if _serialized_size(bounded) > max_bytes:
        bounded = _truncate_text(_serialized(bounded), max_bytes)
    return bounded


def bound_payload(payload: Any, max_bytes: int) -> tuple[Any, bool]:
    """Backstop applied where the frame is measured.

    Returns ``(payload, shrank)``. The largest strings are trimmed first, so a
    small id is never cut while a multi-megabyte blob is.
    """

    if _serialized_size(payload) <= max_bytes:
        return payload, False

    # Longest first: cutting the biggest offender buys the most headroom.
    ordered = sorted(_all_strings(payload), key=_utf8_len, reverse=True)
    for text in ordered:
        if _serialized_size(payload) <= max_bytes:
            break
        if _utf8_len(text) <= 2048:
            # Small enough that cutting it would not help; only replace it when
            # the structure itself is the problem, which _shrink handles.
            continue
        allowed = max_bytes - (_serialized_size(payload) - _utf8_len(text))
        bounded = _truncate_text(text, max(allowed, 0))
        payload = _map_strings(payload, {id(text): bounded})
    if _serialized_size(payload) > max_bytes:
        payload = _shrink(payload, max_bytes)
    return payload, True


def _all_strings(value: Any) -> list[str]:
    found: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, str):
            found.append(node)
        elif isinstance(node, dict):
            for child in node.values():
                walk(child)
        elif isinstance(node, (list, tuple)):
            for child in node:
                walk(child)

    walk(value)
    return found


def _map_strings(node: Any, replacements: dict[int, str]) -> Any:
    """Rebuild ``node`` with the identified strings replaced."""

    if isinstance(node, str):
        return replacements.get(id(node), node)
    if isinstance(node, dict):
        return {key: _map_strings(child, replacements) for key, child in node.items()}
    if isinstance(node, list):
        return [_map_strings(child, replacements) for child in node]
    if isinstance(node, tuple):
        return tuple(_map_strings(child, replacements) for child in node)
    return node


def _serialized(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


def _serialized_size(value: Any) -> int:
    return _utf8_len(_serialized(value))