from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any


def string_attr(value: Any, attr: str) -> str | None:
    candidate = getattr(value, attr, None)
    return candidate if isinstance(candidate, str) and candidate else None


def int_attr(value: Any, attr: str) -> int | None:
    candidate = getattr(value, attr, None)
    return candidate if isinstance(candidate, int) else None


def string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def extract_attr(value: Any, *names: str) -> Any:
    if isinstance(value, Mapping):
        for name in names:
            if name in value:
                return value[name]
        return None
    for name in names:
        candidate = getattr(value, name, None)
        if candidate is not None:
            return candidate
    return None


def optional_attr(root: Any, *paths: str) -> Any:
    for path in paths:
        current = root
        for part in path.split("."):
            current = getattr(current, part, None)
            if current is None:
                break
        if current is not None:
            return current
    return None


def timestamp_from_ms(value: int | None) -> str | None:
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, tz=UTC).isoformat().replace("+00:00", "Z")


def stable_item_id(*values: Any) -> str:
    payload = json.dumps(values, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "claude_" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def content_hash(item_type: str, status: str, role: str | None, content: Any) -> str:
    payload = json.dumps(
        {
            "type": item_type,
            "status": status,
            "role": role,
            "content": content,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()
