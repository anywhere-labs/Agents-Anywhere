"""Keep inline base64 media out of Claude timeline payloads.

Claude history and live tool results carry images (for example a ``Read`` of a
screenshot) as base64 content blocks. Timeline items repeat a tool result in
several fields, so one screenshot used to cost several times its size in every
sync request, and a session with many of them exceeded the ingest request
limit. No client renders these blocks; they showed up as raw JSON text.

The blocks are replaced by a placeholder that keeps the media type and size.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

OMITTED_SOURCE_TYPE = "omitted"
# A ``base64`` field shorter than this is left alone; it cannot be media worth
# dropping and may be ordinary tool data.
_MIN_BASE64_FIELD_CHARS = 1024


def without_inline_media(value: Any) -> Any:
    """Return ``value`` with base64 media replaced; unchanged parts keep their identity."""

    if isinstance(value, Mapping):
        source = value.get("source")
        if _is_base64_source(source):
            return {**value, "source": _omitted_source(source)}
        changed = False
        result: dict[Any, Any] = {}
        for key, item in value.items():
            if key == "base64" and isinstance(item, str) and len(item) >= _MIN_BASE64_FIELD_CHARS:
                result["omittedBase64Bytes"] = _decoded_bytes(item)
                changed = True
                continue
            cleaned = without_inline_media(item)
            changed = changed or cleaned is not item
            result[key] = cleaned
        return result if changed else value
    if isinstance(value, list | tuple):
        cleaned_items = [without_inline_media(item) for item in value]
        if all(cleaned is item for cleaned, item in zip(cleaned_items, value, strict=True)):
            return value
        return cleaned_items
    return value


def omitted_media_summary(content: Any) -> str | None:
    """One line per omitted media block of a tool result, or ``None`` if it has none."""

    if not isinstance(content, list | tuple):
        return None
    lines: list[str] = []
    for block in content:
        if not isinstance(block, Mapping):
            continue
        source = block.get("source")
        if not isinstance(source, Mapping) or source.get("type") != OMITTED_SOURCE_TYPE:
            continue
        label = "Image" if block.get("type") == "image" else "File"
        media_type = source.get("media_type")
        details = [media_type] if isinstance(media_type, str) and media_type else []
        size = source.get("byteSize")
        if isinstance(size, int) and not isinstance(size, bool):
            details.append(_format_bytes(size))
        lines.append(f"[{label} omitted: {', '.join(details)}]" if details else f"[{label} omitted]")
    return "\n".join(lines) if lines else None


def _is_base64_source(source: Any) -> bool:
    return (
        isinstance(source, Mapping)
        and source.get("type") == "base64"
        and isinstance(source.get("data"), str)
    )


def _omitted_source(source: Mapping[str, Any]) -> dict[str, Any]:
    omitted: dict[str, Any] = {
        "type": OMITTED_SOURCE_TYPE,
        "byteSize": _decoded_bytes(source["data"]),
    }
    media_type = source.get("media_type", source.get("mediaType"))
    if isinstance(media_type, str) and media_type:
        omitted["media_type"] = media_type
    return omitted


def _decoded_bytes(data: str) -> int:
    stripped = data.rstrip()
    padding = len(stripped) - len(stripped.rstrip("="))
    return max(0, len(stripped) * 3 // 4 - padding)


def _format_bytes(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.1f} MB"
