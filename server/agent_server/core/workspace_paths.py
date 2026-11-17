"""Normalize a client path against a workspace root, for POSIX and Windows roots."""

from __future__ import annotations

import ntpath
import posixpath
import re

_WINDOWS_DRIVE_RE = re.compile(r"^[A-Za-z]:")


def resolve_workspace_path(root: str | None, raw_path: str) -> str:
    if not root:
        raise ValueError("a workspace root is required")
    if _looks_like_windows_path(root):
        return _resolve_windows_workspace_path(root, raw_path)
    return _resolve_posix_workspace_path(root, raw_path)


def _looks_like_windows_path(path: str) -> bool:
    return (
        bool(_WINDOWS_DRIVE_RE.match(path))
        or path.startswith(("\\\\", "//"))
        or ("\\" in path and not path.startswith("/"))
    )


def _clean_remote_path(path: str) -> str:
    value = path.strip()
    if re.match(r"^/[A-Za-z]:", value):
        value = value[1:]
    return value or "."


def _resolve_windows_workspace_path(root: str, raw_path: str) -> str:
    root_path = ntpath.normpath(_clean_remote_path(root))
    path = _clean_remote_path(raw_path)
    if path.startswith("~"):
        return path

    drive, _ = ntpath.splitdrive(path)
    if drive and ntpath.isabs(path):
        resolved = path
    elif path.startswith(("\\", "/")):
        root_drive, _ = ntpath.splitdrive(root_path)
        resolved = f"{root_drive}{path}" if root_drive else path
    elif drive:
        resolved = ntpath.join(root_path, path[len(drive) :].lstrip("\\/"))
    else:
        resolved = ntpath.join(root_path, path)
    return ntpath.normpath(resolved)


def _resolve_posix_workspace_path(root: str, raw_path: str) -> str:
    root_path = posixpath.normpath(_clean_remote_path(root))
    path = _clean_remote_path(raw_path)
    if path.startswith("~"):
        return path
    if posixpath.isabs(path):
        return posixpath.normpath(path)
    return posixpath.normpath(posixpath.join(root_path, path))
