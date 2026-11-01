"""Locate the installed Antigravity CLI."""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AntigravityLaunch:
    executable: str
    arguments: tuple[str, ...] = ()


def discover_antigravity() -> AntigravityLaunch | None:
    """Locate the antigravity CLI binary."""
    # 1. Environment variable override
    override = os.environ.get("ANTIGRAVITY_BIN")
    if override and os.path.isfile(override) and os.access(override, os.X_OK):
        return AntigravityLaunch(override)

    # 2. User gemini bin
    user_bin = Path.home() / ".gemini" / "antigravity" / "bin" / "antigravity"
    if user_bin.is_file() and os.access(user_bin, os.X_OK):
        return AntigravityLaunch(str(user_bin))

    # 3. Homebrew Cask location
    cask_dir = Path("/opt/homebrew/Caskroom/antigravity-cli")
    if cask_dir.is_dir():
        for candidate in cask_dir.glob("*/antigravity"):
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return AntigravityLaunch(str(candidate))

    # 4. System PATH
    cli = shutil.which("antigravity")
    if cli:
        return AntigravityLaunch(cli)

    return None
