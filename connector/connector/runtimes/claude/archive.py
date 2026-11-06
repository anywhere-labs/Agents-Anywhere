"""Reversible AA-side archive for Claude Code native transcripts.

Claude Code has no archive API. AA mirrors its own archive flag by moving the
native transcript between ``projects`` and ``projects-archived`` under the
Claude config directory, so the session disappears from / reappears in the CLI
history list. This is an Agents Anywhere convention, not an official Claude
Code feature; the move is reversible and never rewrites transcript content.
"""

from __future__ import annotations

import asyncio
import errno
import os
import re
import shutil
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import RuntimeConfig

PROJECTS_DIR_NAME = "projects"
ARCHIVED_PROJECTS_DIR_NAME = "projects-archived"
TRANSCRIPT_SUFFIX = ".jsonl"
# Claude session ids are UUIDs. Accept a conservative safe subset so an
# external session id can never escape the config directory tree.
_SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def claude_config_root(config: RuntimeConfig) -> Path:
    """Resolve Claude Code's config directory for one runtime instance.

    The runtime config can override ``CLAUDE_CONFIG_DIR`` per instance, so the
    process environment is only the fallback (same rule as ClaudePlanningPort).
    """

    environment = config.values.get("environment")
    configured = (
        environment.get("CLAUDE_CONFIG_DIR")
        if isinstance(environment, Mapping)
        else None
    )
    root = configured if isinstance(configured, str) and configured else None
    if root is None:
        root = os.environ.get("CLAUDE_CONFIG_DIR") or None
    return Path(root).expanduser() if root else Path.home() / ".claude"


async def set_transcript_archived(
    config: RuntimeConfig,
    external_session_id: str,
    *,
    archived: bool,
) -> dict[str, Any]:
    """Archive or restore one native Claude transcript, best-effort.

    Returns the ``native``/``supported``/``status``/``reason`` part of the
    ``session.archive`` result; expected misses are reported instead of raised.
    """

    return await asyncio.to_thread(
        _move_transcript,
        claude_config_root(config),
        external_session_id,
        archived=archived,
    )


def _move_transcript(
    config_root: Path,
    external_session_id: str,
    *,
    archived: bool,
) -> dict[str, Any]:
    if _SAFE_SESSION_ID.fullmatch(external_session_id) is None:
        return _outcome(
            supported=False,
            status="unsupported",
            reason="invalid_session_id",
        )
    source_dir_name = PROJECTS_DIR_NAME if archived else ARCHIVED_PROJECTS_DIR_NAME
    target_dir_name = ARCHIVED_PROJECTS_DIR_NAME if archived else PROJECTS_DIR_NAME
    source = _find_transcript(config_root, source_dir_name, external_session_id)
    if source is None:
        already_moved = _find_transcript(
            config_root,
            target_dir_name,
            external_session_id,
        )
        if already_moved is not None:
            return _outcome(
                supported=True,
                status="skipped",
                reason="already_archived" if archived else "already_restored",
            )
        return _outcome(
            supported=False,
            status="unsupported",
            reason="transcript_not_found",
        )
    if _find_transcript(config_root, target_dir_name, external_session_id) is not None:
        return _outcome(
            supported=True,
            status="skipped",
            reason="destination_exists",
        )
    source_path, project_slug = source
    target_path = config_root / target_dir_name / project_slug / source_path.name
    try:
        if not _stays_inside(config_root, source_path) or not _stays_inside(
            config_root,
            target_path,
        ):
            return _outcome(supported=True, status="failed", reason="unsafe_path")
        target_path.parent.mkdir(parents=True, exist_ok=True)
        # ``shutil.move`` copies across drives on Windows, plain rename elsewhere.
        shutil.move(str(source_path), str(target_path))
    except OSError as exc:
        logger.info(
            "claude native transcript archive failed session={} archived={} error={}",
            external_session_id,
            archived,
            exc,
        )
        return _outcome(supported=True, status="failed", reason=_io_reason(exc))
    return _outcome(
        supported=True,
        status="archived" if archived else "restored",
    )


def _outcome(
    *,
    supported: bool,
    status: str,
    reason: str | None = None,
) -> dict[str, Any]:
    # Claude Code has no native archive concept: AA moves its transcript files.
    return {
        "native": False,
        "supported": supported,
        "status": status,
        "reason": reason,
    }


def _stays_inside(config_root: Path, path: Path) -> bool:
    """Reject symlinked transcripts that resolve outside the config directory."""

    try:
        return path.resolve().is_relative_to(config_root.resolve())
    except OSError:
        return False


def _io_reason(exc: OSError) -> str:
    if exc.errno in {errno.EACCES, errno.EPERM}:
        return "permission_denied"
    if exc.errno == errno.ENOENT:
        return "transcript_not_found"
    return "io_error"


def _find_transcript(
    config_root: Path,
    directory_name: str,
    external_session_id: str,
) -> tuple[Path, str] | None:
    """Return the native transcript path and its project slug, if present."""

    filename = f"{external_session_id}{TRANSCRIPT_SUFFIX}"
    for project_dir in _project_dirs(config_root / directory_name):
        candidate = project_dir / filename
        if candidate.is_file():
            return candidate, project_dir.name
    return None


def _project_dirs(projects_dir: Path) -> list[Path]:
    try:
        return sorted(
            (entry for entry in projects_dir.iterdir() if entry.is_dir()),
            key=lambda entry: entry.name,
        )
    except OSError:
        return []
