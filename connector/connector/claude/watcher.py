from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

from loguru import logger


@dataclass(slots=True)
class FileCursor:
    """Per-file read offset so a streaming watcher (Task 4+) can pick up
    where it left off. Task 3 uses cursors only as a 'has this file changed
    since last sync?' fingerprint via size + mtime.
    """
    path: Path
    offset: int = 0
    size: int = 0
    mtime: float = 0.0

    def is_stale(self) -> bool:
        try:
            stat = self.path.stat()
        except OSError:
            return False
        return stat.st_size != self.size or stat.st_mtime != self.mtime

    def refresh_stat(self) -> None:
        try:
            stat = self.path.stat()
        except OSError:
            return
        self.size = stat.st_size
        self.mtime = stat.st_mtime


@dataclass(slots=True)
class JsonlEventBatch:
    events: list[dict[str, Any]]
    complete_offset: int
    size: int
    mtime: float


def iter_jsonl_events(path: Path) -> Iterator[dict[str, Any]]:
    """Yield every fully-parseable JSON line in `path`. Malformed lines
    are skipped with a debug log; truncated trailing lines are simply
    ignored (Claude appends atomically but the last write may still be
    in-flight). Caller decides what to do with each event.
    """
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as fh:
            for line_no, raw in enumerate(fh, start=1):
                stripped = raw.strip()
                if not stripped:
                    continue
                try:
                    yield json.loads(stripped)
                except json.JSONDecodeError:
                    logger.trace(
                        "claude jsonl skipping non-json line path={} line_no={}",
                        path,
                        line_no,
                    )
    except OSError as exc:
        logger.warning("claude jsonl read failed path={} error={}", path, exc)


def list_session_jsonls(projects_dir: Path) -> list[Path]:
    """All `<uuid>.jsonl` files across all per-cwd subdirs.

    `~/.claude/projects/<encoded_cwd>/<uuid>.jsonl` is the convention; the
    `memory/` subdirs that some projects grow are skipped — they hold
    automatic-memory entries, not session transcripts.
    """
    if not projects_dir.is_dir():
        return []
    out: list[Path] = []
    for cwd_dir in projects_dir.iterdir():
        if not cwd_dir.is_dir():
            continue
        for entry in cwd_dir.iterdir():
            if entry.is_file() and entry.suffix == ".jsonl":
                out.append(entry)
    return out


def read_new_events(cursor: FileCursor) -> list[dict[str, Any]]:
    """Read JSON-shaped events appended to `cursor.path` since `cursor.offset`.

    Designed for streaming tail: opens the file in binary mode, seeks to
    the cursor's offset, reads the rest, parses *complete* lines only and
    leaves any trailing partial line for the next call (advancing offset
    to the start of that partial line).

    Updates `cursor.offset`, `cursor.size`, `cursor.mtime` in place. Returns
    the new events in order; empty if the file is unchanged or unreadable.
    """
    batch = peek_new_event_batch(cursor)
    commit_event_batch(cursor, batch)
    return batch.events


def peek_new_event_batch(cursor: FileCursor) -> JsonlEventBatch:
    try:
        stat = cursor.path.stat()
    except OSError:
        return JsonlEventBatch(events=[], complete_offset=cursor.offset, size=cursor.size, mtime=cursor.mtime)

    start_offset = cursor.offset
    if stat.st_size < start_offset:
        start_offset = 0
    if stat.st_size == start_offset and stat.st_mtime == cursor.mtime:
        return JsonlEventBatch(events=[], complete_offset=start_offset, size=stat.st_size, mtime=stat.st_mtime)

    try:
        with cursor.path.open("rb") as fh:
            fh.seek(start_offset)
            blob = fh.read()
    except OSError as exc:
        logger.warning("claude tail read failed path={} error={}", cursor.path, exc)
        return JsonlEventBatch(events=[], complete_offset=start_offset, size=stat.st_size, mtime=stat.st_mtime)

    if not blob:
        return JsonlEventBatch(events=[], complete_offset=start_offset, size=stat.st_size, mtime=stat.st_mtime)

    last_newline = blob.rfind(b"\n")
    if last_newline == -1:
        return JsonlEventBatch(events=[], complete_offset=start_offset, size=stat.st_size, mtime=stat.st_mtime)

    complete = blob[: last_newline + 1]
    events: list[dict[str, Any]] = []
    for raw in complete.splitlines():
        stripped = raw.strip()
        if not stripped:
            continue
        try:
            events.append(json.loads(stripped))
        except json.JSONDecodeError:
            logger.trace("claude tail skipping non-json line path={}", cursor.path)
    return JsonlEventBatch(
        events=events,
        complete_offset=start_offset + len(complete),
        size=stat.st_size,
        mtime=stat.st_mtime,
    )


def commit_event_batch(cursor: FileCursor, batch: JsonlEventBatch) -> None:
    cursor.offset = batch.complete_offset
    cursor.size = batch.size
    cursor.mtime = batch.mtime
