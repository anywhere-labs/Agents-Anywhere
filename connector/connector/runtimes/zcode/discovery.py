"""Locate the installed ZCode CLI without modifying its configuration."""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ZCodeLaunch:
    executable: str
    arguments: tuple[str, ...]


def discover_zcode(*, app_root: Path | None = None) -> ZCodeLaunch | None:
    """Locate a ZCode CJS entry and a Node executable for the local bridge."""
    app = app_root or Path("/Applications/ZCode.app")
    entry = app / "Contents/Resources/glm/zcode.cjs"
    if not entry.is_file():
        cli = shutil.which("zcode")
        candidate = Path(cli).resolve() if cli else None
        if candidate is None or candidate.suffix != ".cjs" or not candidate.is_file():
            return None
        entry = candidate
    node = shutil.which("node")
    if not node:
        for candidate in (Path("/opt/homebrew/bin/node"), Path("/usr/local/bin/node")):
            if candidate.is_file() and os.access(candidate, os.X_OK):
                node = str(candidate)
                break
    if not node:
        return None
    return ZCodeLaunch(node, (str(entry), "app-server"))
