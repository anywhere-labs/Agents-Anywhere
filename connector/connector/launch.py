from __future__ import annotations

import os
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal


Launcher = Literal["direct", "powershell", "cmd"]


@dataclass(frozen=True, slots=True)
class LaunchTarget:
    """How to spawn a CLI agent binary on this host.

    ``path`` is the user-facing / discovery path (agent.cmd, gemini.cmd, …).
    ``exec_argv`` when set is the *actual* argv prefix used for CreateProcess
    (e.g. resolved ``node.exe`` + ``index.js`` for Cursor), avoiding slow
    shell wrappers on Windows.
    """

    source: str
    path: str
    launcher: Launcher = "direct"
    exec_argv: tuple[str, ...] | None = None

    def command(self, args: list[str] | tuple[str, ...] = ()) -> list[str]:
        argv = list(args)
        if self.exec_argv is not None:
            return [*self.exec_argv, *argv]
        if self.launcher == "powershell":
            return [
                _powershell_bin(),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                self.path,
                *argv,
            ]
        if self.launcher == "cmd":
            # Prefer cmd.exe over PowerShell for .cmd/.bat — ~0.5–1s faster cold
            # start, and avoids nested PowerShell when the script itself invokes PS.
            return [_cmd_bin(), "/d", "/c", self.path, *argv]
        return [self.path, *argv]

    def report_path(self) -> str:
        return self.path


def launch_target(source: str, path: str) -> LaunchTarget:
    path = expand_vars(path)
    # Cursor agent.cmd → powershell → node is extremely slow. Prefer direct node.
    cursor_argv = _resolve_cursor_agent_exec(path)
    if cursor_argv is not None:
        return LaunchTarget(
            source=source,
            path=path,
            launcher="direct",
            exec_argv=cursor_argv,
        )

    launcher: Launcher = "direct"
    if sys.platform == "win32":
        suffix = Path(path).suffix.lower()
        if suffix == ".ps1":
            launcher = "powershell"
        elif suffix in {".cmd", ".bat"}:
            launcher = "cmd"
    return LaunchTarget(source=source, path=path, launcher=launcher)


def command_name(name: str) -> LaunchTarget | None:
    found = shutil.which(name)
    if not found:
        return None
    return launch_target("cli", found)


def existing_launch_targets(candidates: list[tuple[str, str]]) -> list[LaunchTarget]:
    seen: set[str] = set()
    out: list[LaunchTarget] = []
    for source, raw in candidates:
        path = expand_vars(raw)
        if not path or path in seen:
            continue
        seen.add(path)
        out.append(launch_target(source, path))
    return out


def expand_vars(value: str) -> str:
    return os.path.expandvars(os.path.expanduser(value))


def path_exists_for_launch(path: str) -> bool:
    if not Path(path).is_file():
        return False
    if sys.platform == "win32":
        return True
    return os.access(path, os.X_OK)


def _resolve_cursor_agent_exec(path: str) -> tuple[str, ...] | None:
    """If *path* is a Cursor agent shim, return ``(node.exe, index.js)``.

    Official Windows install layout::

        %LOCALAPPDATA%/cursor-agent/agent.cmd
          → powershell → cursor-agent.ps1
            → versions/<ver>/node.exe versions/<ver>/index.js

    Spawning node directly cuts multi-second PowerShell cold-start cost that
    previously caused ACP ``initialize`` timeouts.
    """
    try:
        p = Path(path)
    except Exception:
        return None
    name = p.name.lower()
    if name not in {"agent.cmd", "agent.ps1", "cursor-agent.cmd", "cursor-agent.ps1", "agent.exe"}:
        # Only resolve known Cursor install shims / paths under cursor-agent.
        if "cursor-agent" not in str(p).lower().replace("\\", "/"):
            return None
        if name not in {"agent", "cursor-agent"} and not name.startswith("agent"):
            return None

    # Locate install root (directory containing versions/ or node.exe).
    candidates: list[Path] = []
    if p.is_file():
        candidates.append(p.parent)
        candidates.append(p.parent.parent)
    elif p.is_dir():
        candidates.append(p)

    local = os.environ.get("LOCALAPPDATA")
    if local:
        candidates.append(Path(local) / "cursor-agent")

    for root in candidates:
        resolved = _cursor_node_from_root(root)
        if resolved is not None:
            return resolved
    return None


_CURSOR_VERSION_RE = re.compile(r"^\d{4}\.\d{1,2}\.\d{1,2}-.+$")


def _cursor_node_from_root(root: Path) -> tuple[str, ...] | None:
    if not root.is_dir():
        return None
    # Same-dir layout (dev / unpacked)
    local_node = root / "node.exe"
    local_index = root / "index.js"
    if local_node.is_file() and local_index.is_file():
        return (str(local_node), str(local_index))

    versions = root / "versions"
    if not versions.is_dir():
        return None

    version_dirs = [
        d
        for d in versions.iterdir()
        if d.is_dir() and _CURSOR_VERSION_RE.match(d.name)
    ]
    if not version_dirs:
        return None

    def _sort_key(d: Path) -> tuple[int, str]:
        # YYYY.MM.DD-... → integer date for newest-first
        date_part = d.name.split("-", 1)[0]
        parts = date_part.split(".")
        try:
            y, m, day = int(parts[0]), int(parts[1]), int(parts[2])
            return (y * 10000 + m * 100 + day, d.name)
        except (ValueError, IndexError):
            return (0, d.name)

    latest = max(version_dirs, key=_sort_key)
    node = latest / "node.exe"
    index = latest / "index.js"
    if node.is_file() and index.is_file():
        return (str(node), str(index))
    return None


def _cmd_quote(value: str) -> str:
    escaped = value.replace('"', r'\"')
    return f'"{escaped}"'


def _powershell_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _powershell_bin() -> str:
    return shutil.which("powershell.exe") or shutil.which("powershell") or "powershell.exe"


def _cmd_bin() -> str:
    return (
        shutil.which("cmd.exe")
        or shutil.which("cmd")
        or os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "cmd.exe")
    )
