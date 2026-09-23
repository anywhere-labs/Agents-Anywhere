"""Optional read-only acceleration for the native paginated history projection.

The RPC cursor is a position, not a revision. Check every turn's update ordinals
before omitting old pages. Unknown schemas/lineages always use the RPC full read.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any, Mapping


def source_signature(thread: Mapping[str, Any]) -> dict[str, Any] | None:
    path = thread.get("path")
    if not isinstance(path, str) or not Path(path).is_absolute():
        return None
    try:
        stat = Path(path).stat()
        return {"path": path, "device": stat.st_dev, "inode": stat.st_ino,
                "size": stat.st_size, "mtime": stat.st_mtime_ns}
    except OSError:
        return None


def read_history_index(thread: Mapping[str, Any]) -> dict[str, Any] | None:
    source = source_signature(thread)
    thread_id = thread.get("id")
    if source is None or not isinstance(thread_id, str) or thread.get("forkedFromId"):
        return None
    path = Path(source["path"])
    # A custom CODEX_HOME is supported; never guess an index from another home.
    root = next((p.parent for p in list(path.parents)[:5] if p.name in {"sessions", "archived_sessions"}), None)
    if root is None:
        return None
    try:
        with path.open("rb") as stream:
            header = json.loads(stream.readline(1024 * 1024))
        meta = header.get("payload", {})
        if (header.get("type") != "session_meta" or meta.get("id") != thread_id
                or meta.get("history_mode") != "paginated" or meta.get("history_base")
                or meta.get("forked_from_id")):
            return None
        db = sqlite3.connect((root / "thread_history_1.sqlite").as_uri() + "?mode=ro", uri=True, timeout=0.1)
        try:
            db.execute("BEGIN")
            projection = db.execute("SELECT next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id=?", (thread_id,)).fetchone()
            if projection is None or projection[0] != source["size"]:
                return None  # Projection is behind the source; an RPC read must catch it up.
            turns = db.execute("SELECT turn_id, rollout_ordinal, status, error_json, started_at, completed_at, duration_ms FROM thread_turns WHERE thread_id=? ORDER BY rollout_ordinal", (thread_id,)).fetchall()
            hashes = {row[0]: hashlib.sha256(json.dumps(row, separators=(",", ":")).encode()) for row in turns}
            for row in db.execute("SELECT turn_id, item_id, rollout_ordinal, updated_at_ordinal, created_at_ms, item_type FROM thread_items WHERE thread_id=? ORDER BY turn_id, rollout_ordinal, item_id", (thread_id,)):
                if row[0] not in hashes:
                    return None
                hashes[row[0]].update(json.dumps(row, separators=(",", ":")).encode())
            # Compaction changes projection across turn boundaries; calibrate in full.
            if db.execute("SELECT 1 FROM thread_items WHERE thread_id=? AND item_type IN ('contextCompaction', 'context_compaction') LIMIT 1", (thread_id,)).fetchone():
                return None
            result = {"source": source, "ids": [row[0] for row in turns],
                      "revisions": {id: value.hexdigest() for id, value in hashes.items()},
                      "settled": all(row[2] in {"completed", "interrupted", "failed"} for row in turns)}
        finally:
            db.close()
        return result if source_signature(thread) == source else None
    except (OSError, sqlite3.Error, ValueError, TypeError, AttributeError):
        return None


def valid_read_state(value: Any, items: Mapping[str, Any]) -> bool:
    if not isinstance(value, dict) or value.get("version") != 1:
        return False
    index, counts, item_ids = value.get("index"), value.get("counts"), value.get("itemIds")
    if not isinstance(index, dict) or not isinstance(counts, dict) or not isinstance(item_ids, dict):
        return False
    ids, revisions = index.get("ids"), index.get("revisions")
    if not isinstance(index.get("source"), dict) or type(index.get("settled")) is not bool:
        return False
    if (not isinstance(ids, list) or not all(isinstance(id, str) for id in ids)
            or len(ids) != len(set(ids)) or not isinstance(revisions, dict)
            or set(ids) != set(revisions) or set(ids) != set(counts) or set(ids) != set(item_ids)):
        return False
    if not all(isinstance(v, str) for v in revisions.values()):
        return False
    if not all(type(v) is int and v >= 0 for v in counts.values()):
        return False
    if not all(isinstance(v, list) and all(isinstance(id, str) for id in v) for v in item_ids.values()):
        return False
    if any(counts[id] < len(item_ids[id]) for id in ids):
        return False
    flattened = [id for group in item_ids.values() for id in group]
    return len(flattened) == len(set(flattened)) and set(flattened) == set(items)
