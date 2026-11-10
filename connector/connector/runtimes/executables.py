from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


def find_executable_on_path(
    name: str,
    path_value: str | None,
    *,
    platform: str | None = None,
) -> str | None:
    if path_value is None:
        return None
    platform = sys.platform if platform is None else platform
    if platform == "win32":
        # PowerShell scripts are normally absent from PATHEXT. Do not select
        # npm's extensionless POSIX shim, even when Python's which returns it.
        suffixes = (
            ("",) if Path(name).suffix else (".exe", ".com", ".cmd", ".bat", ".ps1")
        )
        for directory in path_value.split(";"):
            if not directory:
                continue
            for suffix in suffixes:
                candidate = Path(os.path.expanduser(directory.strip('"'))) / (
                    name + suffix
                )
                if candidate.is_file():
                    return str(candidate)
        return None
    search_path = os.pathsep.join(
        os.path.expanduser(directory)
        for directory in path_value.split(os.pathsep)
        if directory
    )
    return shutil.which(name, path=search_path)
