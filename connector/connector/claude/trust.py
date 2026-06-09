"""Pre-accept the per-cwd Claude trust dialog.

First time you point `claude` at a brand-new directory, the TUI pops a
'Is this a project you trust?' prompt that blocks everything until you
say yes. The decision is persisted in `~/.claude.json` under
`projects[<cwd>].hasTrustDialogAccepted`.

Daemon-driven spawns shouldn't see that dialog at all. This module writes
the flag *before* spawn. Research doc §3.3: also write the resolved cwd
because macOS may resolve symlinks before the prompt logic runs.
"""

from __future__ import annotations

import json
from pathlib import Path

from loguru import logger


def _claude_config_path() -> Path:
    return Path.home() / ".claude.json"


def ensure_trust(cwd: str | Path, *, config_path: Path | None = None) -> None:
    """Idempotently mark `cwd` (and its resolved form) as trusted."""
    path = config_path or _claude_config_path()
    candidates = _trust_candidates(cwd)

    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("trust: ~/.claude.json unreadable, starting fresh ({})", exc)
        data = {}
    if not isinstance(data, dict):
        data = {}

    projects = data.get("projects")
    if not isinstance(projects, dict):
        projects = {}
        data["projects"] = projects

    changed = False
    for candidate in candidates:
        entry = projects.get(candidate)
        if not isinstance(entry, dict):
            entry = {}
            projects[candidate] = entry
        if not entry.get("hasTrustDialogAccepted"):
            entry["hasTrustDialogAccepted"] = True
            changed = True

    if not changed:
        return

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _trust_candidates(cwd: str | Path) -> list[str]:
    raw = str(cwd)
    candidates = [raw]
    try:
        resolved = str(Path(cwd).resolve())
    except OSError:
        resolved = raw
    if resolved != raw:
        candidates.append(resolved)
    return candidates
