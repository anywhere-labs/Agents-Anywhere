"""Minimal JSON Patch (RFC 6902 subset) for Codex IPC thread-stream patches.

The owner window broadcasts Immer-style patches whose ``path`` is already an
array of keys (object keys or array indexes) rather than a JSON Pointer string.
Only ``add``, ``replace`` and ``remove`` are produced by Codex; the other RFC
operations are implemented for completeness.
"""

from __future__ import annotations

import copy
from collections.abc import Mapping, Sequence
from typing import Any


class JsonPatchError(ValueError):
    """Raised when a patch cannot be applied to the document."""


def apply_patches(document: Any, patches: Sequence[Mapping[str, Any]]) -> Any:
    """Return a new document with ``patches`` applied in order.

    The input document is never mutated; containers along touched paths are
    copied so callers can keep references to the previous revision.
    """

    result = copy.deepcopy(document)
    for patch in patches:
        result = _apply_one(result, patch)
    return result


def _apply_one(document: Any, patch: Mapping[str, Any]) -> Any:
    op = patch.get("op")
    path = _normalize_path(patch.get("path"))
    if op == "add":
        return _set(document, path, patch.get("value"), insert=True)
    if op == "replace":
        return _set(document, path, patch.get("value"), insert=False)
    if op == "remove":
        return _remove(document, path)
    if op == "move":
        source = _normalize_path(patch.get("from"))
        value = _get(document, source)
        document = _remove(document, source)
        return _set(document, path, value, insert=True)
    if op == "copy":
        value = copy.deepcopy(_get(document, _normalize_path(patch.get("from"))))
        return _set(document, path, value, insert=True)
    if op == "test":
        if _get(document, path) != patch.get("value"):
            raise JsonPatchError(f"test failed at {path}")
        return document
    raise JsonPatchError(f"unsupported op {op!r}")


def _normalize_path(raw: Any) -> list[Any]:
    if isinstance(raw, str):
        if raw == "":
            return []
        if not raw.startswith("/"):
            raise JsonPatchError(f"invalid path {raw!r}")
        return [part.replace("~1", "/").replace("~0", "~") for part in raw.split("/")[1:]]
    if isinstance(raw, (list, tuple)):
        return list(raw)
    raise JsonPatchError(f"invalid path {raw!r}")


def _get(document: Any, path: list[Any]) -> Any:
    current = document
    for key in path:
        if isinstance(current, dict):
            if key not in current:
                raise JsonPatchError(f"missing key {key!r}")
            current = current[key]
        elif isinstance(current, list):
            current = current[_index(current, key, allow_end=False)]
        else:
            raise JsonPatchError(f"cannot descend into {type(current).__name__}")
    return current


def _set(document: Any, path: list[Any], value: Any, *, insert: bool) -> Any:
    if not path:
        return value
    key, rest = path[0], path[1:]
    if isinstance(document, dict):
        updated = dict(document)
        if rest:
            if key not in updated:
                if not insert:
                    raise JsonPatchError(f"missing key {key!r}")
                updated[key] = {} if not isinstance(rest[0], int) else []
            updated[key] = _set(updated[key], rest, value, insert=insert)
        else:
            updated[key] = value
        return updated
    if isinstance(document, list):
        updated = list(document)
        if rest:
            index = _index(updated, key, allow_end=False)
            updated[index] = _set(updated[index], rest, value, insert=insert)
            return updated
        if insert:
            index = _index(updated, key, allow_end=True)
            updated.insert(index, value)
        else:
            updated[_index(updated, key, allow_end=False)] = value
        return updated
    if document is None and insert:
        container: Any = [] if isinstance(key, int) or key == "-" else {}
        return _set(container, path, value, insert=True)
    raise JsonPatchError(f"cannot set {key!r} on {type(document).__name__}")


def _remove(document: Any, path: list[Any]) -> Any:
    if not path:
        raise JsonPatchError("cannot remove the root document")
    key, rest = path[0], path[1:]
    if isinstance(document, dict):
        if key not in document:
            raise JsonPatchError(f"missing key {key!r}")
        updated = dict(document)
        if rest:
            updated[key] = _remove(updated[key], rest)
        else:
            del updated[key]
        return updated
    if isinstance(document, list):
        index = _index(document, key, allow_end=False)
        updated = list(document)
        if rest:
            updated[index] = _remove(updated[index], rest)
        else:
            del updated[index]
        return updated
    raise JsonPatchError(f"cannot remove {key!r} from {type(document).__name__}")


def _index(container: list[Any], key: Any, *, allow_end: bool) -> int:
    if key == "-":
        if not allow_end:
            raise JsonPatchError("'-' is only valid when appending")
        return len(container)
    try:
        index = int(key)
    except (TypeError, ValueError) as exc:
        raise JsonPatchError(f"invalid array index {key!r}") from exc
    limit = len(container) + (1 if allow_end else 0)
    if index < 0 or index >= limit:
        raise JsonPatchError(f"array index {index} out of range")
    return index
