from __future__ import annotations

import json
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from connector.runtime_protocol.errors import RuntimeUnavailableError
from connector.runtimes.executables import find_executable_on_path

SCRIPT_SUFFIXES = frozenset({".js", ".mjs", ".cjs"})
SHIM_SUFFIXES = frozenset({".cmd", ".bat", ".ps1"})
PACKAGE_ENTRY = Path("node_modules") / "command-code" / "dist" / "index.mjs"


class CommandCodeUnavailableError(RuntimeUnavailableError):
    code = "commandcode_cli_missing"
    retryable = False


@dataclass(frozen=True, slots=True)
class CommandCodeInstallation:
    executable: str
    arguments: tuple[str, ...]
    version: str
    environment: tuple[tuple[str, str], ...]
    source: str


def installation_metadata(
    installation: CommandCodeInstallation,
) -> dict[str, object]:
    return {
        "executable": installation.executable,
        "arguments": list(installation.arguments),
        "version": installation.version,
        "source": installation.source,
    }


def resolve_command_code(
    values: Mapping[str, Any],
    *,
    path_value: str | None = None,
    platform: str | None = None,
    environ: Mapping[str, str] | None = None,
) -> CommandCodeInstallation:
    environment = dict(os.environ if environ is None else environ)
    platform = sys.platform if platform is None else platform
    path_value = _environment_path(environment) if path_value is None else path_value

    configured = values.get("cliPath")
    if isinstance(configured, str) and configured.strip():
        path = Path(_expand(configured.strip()))
        if not path.is_file():
            raise CommandCodeUnavailableError(
                f"Command Code CLI path does not exist: {path}"
            )
        return _from_path(
            path,
            path_value=path_value,
            platform=platform,
            environ=environment,
            source="configured",
        )

    for name in _command_names(platform):
        found = find_executable_on_path(name, path_value, platform=platform)
        if found:
            return _from_path(
                Path(found),
                path_value=path_value,
                platform=platform,
                environ=environment,
                source="path",
            )

    for entry in _npm_entries(environment, platform):
        if entry.is_file():
            return _node_installation(
                entry,
                path_value=path_value,
                platform=platform,
                environ=environment,
                source="npm",
            )

    for entry in _desktop_entries(environment, platform):
        if entry.is_file():
            return _node_installation(
                entry,
                path_value=path_value,
                platform=platform,
                environ=environment,
                source="desktop",
            )

    raise CommandCodeUnavailableError(
        "Command Code CLI was not found. Install it with "
        "`npm i -g command-code@latest`, or set the CLI path to cmdc or "
        "node_modules/command-code/dist/index.mjs."
    )


def _from_path(
    path: Path,
    *,
    path_value: str | None,
    platform: str,
    environ: Mapping[str, str],
    source: str,
) -> CommandCodeInstallation:
    entry = _script_entry(path)
    if entry is not None:
        return _node_installation(
            entry,
            path_value=path_value,
            platform=platform,
            environ=environ,
            source=source,
        )
    if path.suffix.lower() in SHIM_SUFFIXES:
        raise CommandCodeUnavailableError(
            f"Found a Command Code shell shim at {path}, but could not locate "
            f"{PACKAGE_ENTRY.as_posix()}. Set the CLI path to that file or install "
            "command-code with npm."
        )
    return CommandCodeInstallation(
        executable=str(path),
        arguments=(),
        version=_package_version(path),
        environment=(),
        source=source,
    )


def _script_entry(path: Path) -> Path | None:
    if path.suffix.lower() in SCRIPT_SUFFIXES:
        return path
    if path.suffix.lower() in SHIM_SUFFIXES:
        candidate = path.parent / PACKAGE_ENTRY
        return candidate if candidate.is_file() else None
    resolved = path.resolve()
    if resolved.suffix.lower() in SCRIPT_SUFFIXES and resolved.is_file():
        return resolved
    return None


def _node_installation(
    entry: Path,
    *,
    path_value: str | None,
    platform: str,
    environ: Mapping[str, str],
    source: str,
) -> CommandCodeInstallation:
    version = _package_version(entry)
    node = find_executable_on_path("node", path_value, platform=platform)
    if node:
        return CommandCodeInstallation(
            executable=node,
            arguments=(str(entry),),
            version=version,
            environment=(),
            source=source,
        )
    electron = _desktop_binary(environ, platform)
    if electron is not None:
        return CommandCodeInstallation(
            executable=str(electron),
            arguments=(str(entry),),
            version=version,
            environment=(("ELECTRON_RUN_AS_NODE", "1"),),
            source=source + "-electron",
        )
    raise CommandCodeUnavailableError(
        "The Command Code CLI was found, but Node was not. Install Node 22 or "
        "set the CLI path to a runnable entry point."
    )


def _command_names(platform: str) -> tuple[str, ...]:
    if platform == "win32":
        # Never search "cmd" on Windows: it resolves to C:\Windows\System32\cmd.exe.
        return ("cmdc", "command-code", "commandcode")
    return ("cmdc", "command-code", "cmd", "commandcode")


def _npm_entries(
    environ: Mapping[str, str], platform: str
) -> tuple[Path, ...]:
    if platform == "win32":
        roots = [
            Path(environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "npm",
            Path(
                environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")
            )
            / "npm",
        ]
    else:
        roots = [
            Path.home() / ".npm-global" / "lib",
            Path("/usr/local/lib"),
            Path("/opt/homebrew/lib"),
            Path.home() / ".local" / "lib",
        ]
    return tuple(root / "node_modules" / "command-code" / "dist" / "index.mjs" for root in roots)


def _desktop_entries(
    environ: Mapping[str, str], platform: str
) -> tuple[Path, ...]:
    if platform == "win32":
        programs = Path(
            environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")
        ) / "Programs"
        return (
            programs
            / "Command Code"
            / "resources"
            / "app"
            / "node_modules"
            / "command-code"
            / "dist"
            / "index.mjs",
        )
    if platform == "darwin":
        apps = [
            Path("/Applications"),
            Path.home() / "Applications",
        ]
        return tuple(
            app
            / "Command Code.app"
            / "Contents"
            / "Resources"
            / "app"
            / "node_modules"
            / "command-code"
            / "dist"
            / "index.mjs"
            for app in apps
        )
    return ()


def _desktop_binary(
    environ: Mapping[str, str], platform: str
) -> Path | None:
    if platform == "win32":
        candidate = (
            Path(environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
            / "Programs"
            / "Command Code"
            / "Command Code.exe"
        )
        return candidate if candidate.is_file() else None
    if platform == "darwin":
        for apps in (Path("/Applications"), Path.home() / "Applications"):
            candidate = (
                apps / "Command Code.app" / "Contents" / "MacOS" / "Command Code"
            )
            if candidate.is_file():
                return candidate
    return None


def _package_version(entry: Path) -> str:
    candidates = (
        entry.parent.parent / "package.json",
        entry.parent / "package.json",
    )
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        version = data.get("version")
        if isinstance(version, str) and version.strip():
            return version.strip()
    return "unknown"


def _environment_path(environ: Mapping[str, str]) -> str | None:
    for key, value in environ.items():
        if key.upper() == "PATH":
            return value
    return None


def _expand(value: str) -> str:
    return os.path.expandvars(os.path.expanduser(value))
