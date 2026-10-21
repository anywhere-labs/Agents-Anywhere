"""Socket path and ownership rules for the Codex IPC router socket."""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

IPC_DIRECTORY_NAME = "ipc"
IPC_SOCKET_NAME = "ipc.sock"
WINDOWS_PIPE_PATH = r"\\.\pipe\codex-ipc"


class IpcPathError(OSError):
    """Raised when the IPC directory or socket fails the ownership checks."""


def is_supported_platform() -> bool:
    return sys.platform != "win32"


def ipc_socket_path(codex_home: str | os.PathLike[str]) -> Path:
    if sys.platform == "win32":
        return Path(WINDOWS_PIPE_PATH)
    return Path(codex_home) / IPC_DIRECTORY_NAME / IPC_SOCKET_NAME


def ensure_ipc_directory(codex_home: str | os.PathLike[str]) -> Path:
    """Create ``$CODEX_HOME/ipc`` with mode 0700 and verify we own it.

    Mirrors the extension: a directory that is not owned by the current user is
    refused so that another user cannot plant a socket there.
    """

    directory = Path(codex_home) / IPC_DIRECTORY_NAME
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    uid = _current_uid()
    if uid is None or not stat.S_ISDIR(info.st_mode) or info.st_uid != uid:
        raise IpcPathError("Codex IPC directory is not owned by the current user")
    directory.chmod(0o700)
    return directory


def socket_owned_by_current_user(path: Path) -> bool:
    uid = _current_uid()
    if uid is None:
        return False
    try:
        info = path.lstat()
    except OSError:
        return False
    return stat.S_ISSOCK(info.st_mode) and info.st_uid == uid


def remove_stale_socket(path: Path) -> None:
    """Unlink a leftover socket file, but only one that belongs to us."""

    if socket_owned_by_current_user(path):
        try:
            path.unlink()
        except FileNotFoundError:
            pass


def secure_listening_socket(path: Path) -> None:
    """Restrict a freshly bound socket to the current user (mode 0600)."""

    if not socket_owned_by_current_user(path):
        raise IpcPathError("Codex IPC socket is not owned by the current user")
    path.chmod(0o600)


def _current_uid() -> int | None:
    getuid = getattr(os, "getuid", None)
    return getuid() if getuid is not None else None
