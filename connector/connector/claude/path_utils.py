from __future__ import annotations

import hashlib
from pathlib import Path


def encode_cwd(cwd: str | Path) -> str:
    """Map an absolute cwd to its `~/.claude/projects/<this>/` subdir name.

    Claude resolves symlinks before encoding, so we must too — macOS `/tmp`
    is really `/private/tmp` and that's what shows up on disk. Same rule on
    Linux / Windows; replace `/`, `\\`, `:`, `.` with `-`.
    """
    resolved = str(Path(cwd).resolve())
    for ch in ("/", "\\", ":", "."):
        resolved = resolved.replace(ch, "-")
    return resolved


def projects_root() -> Path:
    """Where Claude stores per-cwd session directories."""
    return Path.home() / ".claude" / "projects"


def stable_claude_session_id(connector_id: str, claude_uuid: str) -> str:
    """Deterministic session_id derived from (connector, claude session uuid).

    Mirrors connector.codex.adapter.stable_session_id so the backend never
    sees two ids referring to the same upstream session.
    """
    digest = hashlib.sha256(f"{connector_id}:claude:{claude_uuid}".encode("utf-8")).hexdigest()[:24]
    return f"sess_claude_{digest}"


def claude_uuid_from_jsonl(path: Path) -> str:
    """The basename minus `.jsonl` is the Claude session uuid."""
    return path.stem
