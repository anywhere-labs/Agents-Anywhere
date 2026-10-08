"""Pi session file discovery and parsing.

Pi stores sessions as JSONL under ``~/.pi/agent/sessions/--<path>--/``.
The first line is a session header; later lines are tree entries linked by
``id``/``parentId``. This module reads those files without invoking Pi, so the
connector can list and project sessions that have no running process.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024
TITLE_MAX_LENGTH = 120


@dataclass(frozen=True, slots=True)
class PiSessionSummary:
    path: str
    session_id: str
    cwd: str | None
    created_at: str | None
    modified_at: float
    title: str | None
    version: int | None = None
    parent_session: str | None = None
    size: int = 0

    def metadata(self) -> dict[str, Any]:
        return {
            "piSessionId": self.session_id,
            "piSessionFile": self.path,
            "piSessionVersion": self.version,
        }


@dataclass(frozen=True, slots=True)
class PiSessionDoc:
    summary: PiSessionSummary
    header: Mapping[str, Any]
    entries: tuple[Mapping[str, Any], ...] = field(default_factory=tuple)


def _extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, Mapping) and block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "".join(parts)


# AA's new-session composer sends its default title ("新建会话") with the
# create request. It is not a user-chosen name, and persisting it in the pi
# session file would permanently shadow the first-message title fallback.
PLACEHOLDER_TITLES = frozenset({"新建会话", "New session"})


def is_meaningful_title(value: str | None) -> bool:
    """Whether a session name is worth persisting as the title."""

    if not isinstance(value, str):
        return False
    text = value.strip()
    return bool(text) and text not in PLACEHOLDER_TITLES


def _truncate_title(text: str) -> str | None:
    cleaned = " ".join(text.split())
    if not cleaned:
        return None
    if len(cleaned) <= TITLE_MAX_LENGTH:
        return cleaned
    return cleaned[: TITLE_MAX_LENGTH - 1] + "…"


def iter_session_lines(path: Path):
    """Yield parsed JSON objects from a session file, skipping bad lines."""

    try:
        with path.open("rb") as handle:
            for raw in handle:
                stripped = raw.strip()
                if not stripped:
                    continue
                try:
                    record = json.loads(stripped)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, Mapping):
                    yield record
    except OSError as exc:
        logger.warning("cannot read pi session %s: %s", path, exc)


def summarize_session(path: Path) -> PiSessionSummary | None:
    """Read the header, display name, and first user message of one file."""

    try:
        stat = path.stat()
    except OSError:
        return None
    if stat.st_size > MAX_SESSION_FILE_BYTES:
        logger.warning("skipping oversized pi session file %s", path)
        return None

    header: Mapping[str, Any] | None = None
    title: str | None = None
    first_user_text: str | None = None
    for record in iter_session_lines(path):
        if header is None:
            if record.get("type") != "session":
                return None
            header = record
            continue
        if record.get("type") == "session_info":
            name = record.get("name")
            if is_meaningful_title(name):
                title = name.strip()
        elif first_user_text is None and record.get("type") == "message":
            message = record.get("message")
            if isinstance(message, Mapping) and message.get("role") == "user":
                first_user_text = _extract_text(message.get("content"))

    if header is None:
        return None
    session_id = header.get("id")
    if not isinstance(session_id, str) or not session_id:
        session_id = path.stem
    cwd = header.get("cwd")
    created_at = header.get("timestamp")
    version = header.get("version")
    parent = header.get("parentSession")
    return PiSessionSummary(
        path=str(path),
        session_id=session_id,
        cwd=cwd if isinstance(cwd, str) else None,
        created_at=created_at if isinstance(created_at, str) else None,
        modified_at=stat.st_mtime,
        title=title or _truncate_title(first_user_text or ""),
        version=version if isinstance(version, int) else None,
        parent_session=parent if isinstance(parent, str) else None,
        size=stat.st_size,
    )


class SessionDirectory:
    """Cached view over a Pi sessions directory."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._cache: dict[str, tuple[float, int, PiSessionSummary]] = {}

    def list_sessions(self, limit: int = 100) -> list[PiSessionSummary]:
        if not self.root.is_dir():
            return []
        discovered: list[Path] = []
        for path in self.root.rglob("*.jsonl"):
            if path.is_file():
                discovered.append(path)
        summaries: list[PiSessionSummary] = []
        seen: set[str] = set()
        for path in discovered:
            key = str(path)
            seen.add(key)
            try:
                stat = path.stat()
            except OSError:
                continue
            cached = self._cache.get(key)
            if cached is not None and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
                summaries.append(cached[2])
                continue
            summary = summarize_session(path)
            if summary is None:
                continue
            self._cache[key] = (summary.modified_at, summary.size, summary)
            summaries.append(summary)
        for stale in set(self._cache) - seen:
            self._cache.pop(stale, None)
        summaries.sort(key=lambda item: item.modified_at, reverse=True)
        if limit > 0:
            return summaries[:limit]
        return summaries

    def find_by_path(self, path: str) -> PiSessionSummary | None:
        candidate = Path(path).expanduser()
        if not candidate.is_file():
            return None
        summary = summarize_session(candidate)
        if summary is not None:
            self._cache[str(candidate)] = (
                summary.modified_at,
                summary.size,
                summary,
            )
        return summary


def load_session_doc(path: Path) -> PiSessionDoc | None:
    """Parse a session file and return the active branch of its entry tree."""

    summary = summarize_session(path)
    if summary is None:
        return None
    entries: list[Mapping[str, Any]] = []
    header: Mapping[str, Any] | None = None
    for record in iter_session_lines(path):
        if header is None and record.get("type") == "session":
            header = record
            continue
        entries.append(record)
    if header is None:
        return None
    return PiSessionDoc(
        summary=summary,
        header=header,
        entries=tuple(_active_branch(entries)),
    )


def _active_branch(entries: list[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    """Return entries on the branch that ends at the last recorded entry."""

    keyed: dict[str, Mapping[str, Any]] = {}
    order: list[Mapping[str, Any]] = []
    for record in entries:
        entry_id = record.get("id")
        if isinstance(entry_id, str) and entry_id:
            keyed[entry_id] = record
        order.append(record)

    last_with_id: Mapping[str, Any] | None = None
    for record in reversed(order):
        entry_id = record.get("id")
        if isinstance(entry_id, str) and entry_id in keyed:
            last_with_id = record
            break
    if last_with_id is None:
        # Version 1 files or defensively broken files: file order is the branch.
        return [record for record in order if record.get("type") != "session"]

    chain: list[Mapping[str, Any]] = []
    visited: set[str] = set()
    current: Mapping[str, Any] | None = last_with_id
    while current is not None:
        entry_id = current.get("id")
        if not isinstance(entry_id, str) or entry_id in visited:
            break
        visited.add(entry_id)
        chain.append(current)
        parent_id = current.get("parentId")
        if not isinstance(parent_id, str):
            break
        current = keyed.get(parent_id)
    chain.reverse()
    return chain
