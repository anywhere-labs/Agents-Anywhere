"""Optional read-only acceleration for the native paginated history projection.

The RPC cursor is a position, not a revision. Check every turn's update ordinals
before omitting old pages. Unknown schemas/lineages always use the RPC full read.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import psutil

_NATIVE_ACTIVITY_STARTUP_GRACE_SECONDS = 30


@dataclass(frozen=True, slots=True)
class NativeThreadActivity:
    status: Literal["idle", "running"]
    turn_id: str
    native_status: str
    evidence: Literal["terminal", "owner", "recent", "stale"]


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


def read_native_thread_activity(
    thread: Mapping[str, Any],
) -> NativeThreadActivity | None:
    """Read the latest native turn state without requiring a settled projection.

    Codex app-server reports desktop-owned threads as ``notLoaded``. The native
    history database is the shared read-only source that the desktop itself
    updates while such a turn is running.
    """

    native_source = _native_history_source(thread)
    if native_source is None:
        return None
    source, thread_id, database_path = native_source
    try:
        database_uri = database_path.as_uri() + "?mode=ro"
        with sqlite3.connect(database_uri, uri=True, timeout=0.1) as database:
            row = database.execute(
                "SELECT turn_id, status FROM thread_turns "
                "WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1",
                (thread_id,),
            ).fetchone()
        if row is None or not isinstance(row[0], str) or not isinstance(row[1], str):
            return None
        normalized_status = row[1].replace("_", "").lower()
        if normalized_status in {"inprogress", "running"}:
            if _source_is_open_by_codex(source):
                status: Literal["idle", "running"] = "running"
                evidence: Literal["terminal", "owner", "recent", "stale"] = (
                    "owner"
                )
            elif _source_is_recent(source):
                status = "running"
                evidence = "recent"
            else:
                # Codex can leave an inProgress row behind when a desktop-owned
                # task is unloaded without a terminal event. Once no Codex
                # process owns the rollout and the short startup race has
                # elapsed, that row is historical rather than live activity.
                status = "idle"
                evidence = "stale"
        elif normalized_status in {"completed", "interrupted", "failed"}:
            status = "idle"
            evidence = "terminal"
        else:
            return None
        current_source = source_signature(thread)
        if current_source is None or any(
            current_source[key] != source[key] for key in ("path", "device", "inode")
        ):
            return None
        return NativeThreadActivity(
            status=status,
            turn_id=row[0],
            native_status=row[1],
            evidence=evidence,
        )
    except (OSError, sqlite3.Error, ValueError, TypeError, AttributeError):
        return None


def _source_is_recent(source: Mapping[str, Any]) -> bool:
    mtime_ns = source.get("mtime")
    if not isinstance(mtime_ns, int):
        return False
    age_ns = time.time_ns() - mtime_ns
    return age_ns <= _NATIVE_ACTIVITY_STARTUP_GRACE_SECONDS * 1_000_000_000


def _source_is_open_by_codex(source: Mapping[str, Any]) -> bool:
    device = source.get("device")
    inode = source.get("inode")
    if not isinstance(device, int) or not isinstance(inode, int):
        return False
    return (device, inode) in _open_codex_file_identities(int(time.monotonic()))


@lru_cache(maxsize=2)
def _open_codex_file_identities(
    _cache_second: int,
) -> frozenset[tuple[int, int]]:
    identities: set[tuple[int, int]] = set()
    for process in psutil.process_iter(["name", "exe", "cmdline"]):
        try:
            if not _is_codex_process(process.info):
                continue
            for opened_file in process.open_files():
                try:
                    stat = Path(opened_file.path).stat()
                except OSError:
                    continue
                identities.add((stat.st_dev, stat.st_ino))
        except (psutil.Error, OSError):
            continue
    return frozenset(identities)


def _is_codex_process(info: Mapping[str, Any]) -> bool:
    cmdline = info.get("cmdline")
    executable_candidates = [info.get("name"), info.get("exe")]
    if isinstance(cmdline, list) and cmdline:
        executable_candidates.append(cmdline[0])
    for candidate in executable_candidates:
        if not isinstance(candidate, str) or not candidate:
            continue
        executable_name = Path(candidate).name.casefold()
        if executable_name in {"codex", "codex.exe"} or executable_name.startswith(
            "codex-"
        ):
            return True
    return False


def read_history_index(thread: Mapping[str, Any]) -> dict[str, Any] | None:
    native_source = _native_history_source(thread)
    if native_source is None:
        return None
    source, thread_id, database_path = native_source
    try:
        db = sqlite3.connect(database_path.as_uri() + "?mode=ro", uri=True, timeout=0.1)
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


def _native_history_source(
    thread: Mapping[str, Any],
) -> tuple[dict[str, Any], str, Path] | None:
    source = source_signature(thread)
    thread_id = thread.get("id")
    if source is None or not isinstance(thread_id, str) or thread.get("forkedFromId"):
        return None
    path = Path(source["path"])
    # A custom CODEX_HOME is supported; never guess an index from another home.
    root = next(
        (
            parent.parent
            for parent in list(path.parents)[:5]
            if parent.name in {"sessions", "archived_sessions"}
        ),
        None,
    )
    if root is None:
        return None
    try:
        with path.open("rb") as stream:
            header = json.loads(stream.readline(1024 * 1024))
        metadata = header.get("payload", {})
        if (
            header.get("type") != "session_meta"
            or metadata.get("id") != thread_id
            or metadata.get("history_mode") != "paginated"
            or metadata.get("history_base")
            or metadata.get("forked_from_id")
        ):
            return None
    except (OSError, ValueError, TypeError, AttributeError):
        return None
    return source, thread_id, root / "thread_history_1.sqlite"


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
