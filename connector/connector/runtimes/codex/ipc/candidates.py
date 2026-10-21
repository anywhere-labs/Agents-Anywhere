"""Candidate threads to probe for an IPC owner.

Ownership itself is only known to the owner; we feed discovery with the thread
ids that are most likely loaded somewhere: ids that have a writer lock file
(created the first time an app-server loads a thread, left behind until Codex
cleans stale ones) and the most recently updated entries of
``session_index.jsonl``.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

WRITER_LOCK_DIRECTORY = "thread-writer-locks"
SESSION_INDEX_FILE = "session_index.jsonl"
_THREAD_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def candidate_thread_ids(
    codex_home: str | os.PathLike[str],
    *,
    recent_limit: int = 20,
) -> list[str]:
    """Return thread ids worth asking the router about, most relevant first."""

    home = Path(codex_home)
    ordered: list[str] = []
    seen: set[str] = set()

    def add(thread_id: str) -> None:
        if _THREAD_ID.match(thread_id) and thread_id not in seen:
            seen.add(thread_id)
            ordered.append(thread_id)

    lock_dir = home / WRITER_LOCK_DIRECTORY
    try:
        locks = sorted(
            (entry for entry in lock_dir.iterdir() if entry.suffix == ".lock"),
            key=lambda entry: entry.stat().st_mtime,
            reverse=True,
        )
    except OSError:
        locks = []
    for entry in locks:
        add(entry.stem)

    for thread_id in recent_session_ids(home, limit=recent_limit):
        add(thread_id)
    return ordered


def recent_session_ids(codex_home: str | os.PathLike[str], *, limit: int = 20) -> list[str]:
    index = Path(codex_home) / SESSION_INDEX_FILE
    try:
        lines = index.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    rows: list[tuple[str, str]] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        thread_id = row.get("id")
        if not isinstance(thread_id, str):
            continue
        updated = row.get("updated_at")
        rows.append((updated if isinstance(updated, str) else "", thread_id))
    latest: dict[str, str] = {}
    for updated, thread_id in rows:
        if updated >= latest.get(thread_id, ""):
            latest[thread_id] = updated
    ranked = sorted(latest.items(), key=lambda item: item[1], reverse=True)
    return [thread_id for thread_id, _ in ranked[:limit]]
