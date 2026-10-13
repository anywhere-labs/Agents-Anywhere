"""Resolve the command line that starts Pi.

On Windows, npm installs ``pi`` as a ``pi.cmd`` shim. Spawning the shim goes
through ``cmd.exe``: argument quoting changes, and terminating the shim leaves
the real ``node`` process orphaned. When the shim belongs to an npm global
install, run ``node <cli.js>`` directly instead.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

CLI_RELATIVE = Path("node_modules") / "@earendil-works" / "pi-coding-agent" / "dist" / "bundle" / "cli.js"


def resolve_pi_command(executable: str) -> list[str] | None:
    """Return argv prefix for Pi, or None when the executable cannot be found."""

    path = Path(executable).expanduser()
    resolved = str(path) if path.is_absolute() else shutil.which(executable)
    if resolved is None or not Path(resolved).exists():
        return None
    if sys.platform == "win32" and Path(resolved).suffix.lower() in {".cmd", ".bat", ".ps1", ""}:
        shim_dir = Path(resolved).parent
        cli = shim_dir / CLI_RELATIVE
        if cli.is_file():
            node = shim_dir / "node.exe"
            node_path = str(node) if node.is_file() else shutil.which("node")
            if node_path:
                return [node_path, str(cli)]
    return [resolved]
