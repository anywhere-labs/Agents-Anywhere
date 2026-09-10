from __future__ import annotations

import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal


Launcher = Literal["direct", "powershell", "cmd"]


@dataclass(frozen=True, slots=True)
class LaunchTarget:
    source: str
    path: str
    launcher: Launcher = "direct"

    def command(self, args: list[str] | tuple[str, ...] = ()) -> list[str]:
        argv = list(args)
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
            script = _powershell_invoke_script(self.path, argv)
            return [
                _powershell_bin(),
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ]
        return [self.path, *argv]

    def report_path(self) -> str:
        return self.path


def launch_target(source: str, path: str) -> LaunchTarget:
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


def _powershell_invoke_script(path: str, args: list[str]) -> str:
    return " ".join(["&", _powershell_quote(path), *(_powershell_quote(arg) for arg in args)])


def _cmd_quote(value: str) -> str:
    escaped = value.replace('"', r'\"')
    return f'"{escaped}"'


def _powershell_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _powershell_bin() -> str:
    return shutil.which("powershell.exe") or shutil.which("powershell") or "powershell.exe"
