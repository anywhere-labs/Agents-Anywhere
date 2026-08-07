from __future__ import annotations

import importlib
import importlib.metadata
import os
import shutil
import sys
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from connector.launch import LaunchTarget, launch_target
from connector.runtime_protocol import RuntimeInvalidRequestError

SdkLoader = Callable[[], Any]
CommandChecker = Callable[[LaunchTarget, Mapping[str, str]], dict[str, Any]]


def load_claude_sdk() -> Any:
    return importlib.import_module("claude_agent_sdk")


def check_sdk(loader: SdkLoader) -> dict[str, Any]:
    try:
        module = loader()
    except ModuleNotFoundError as exc:
        return {
            "available": False,
            "package": "claude-agent-sdk",
            "reason": str(exc) or "package not installed",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "available": False,
            "package": "claude-agent-sdk",
            "reason": str(exc) or exc.__class__.__name__,
        }
    version = getattr(module, "__version__", None)
    if not isinstance(version, str):
        try:
            version = importlib.metadata.version("claude-agent-sdk")
        except importlib.metadata.PackageNotFoundError:
            version = None
    return {
        "available": True,
        "package": "claude-agent-sdk",
        **({"version": version} if isinstance(version, str) and version else {}),
    }


def discover_claude_target(
    command_checker: CommandChecker,
    environment: Mapping[str, str],
) -> LaunchTarget | None:
    for target in claude_candidate_targets():
        result = command_checker(target, environment)
        if result.get("status") == "ok":
            return target
    return None


def resolve_target(
    raw_values: Mapping[str, Any],
    environment: Mapping[str, str],
    discovered_target: LaunchTarget | None,
    command_checker: CommandChecker,
) -> LaunchTarget | None:
    raw_path = raw_values.get("executablePath")
    if isinstance(raw_path, str) and raw_path:
        target = launch_target(
            "configured", os.path.expandvars(os.path.expanduser(raw_path))
        )
        result = command_checker(target, environment)
        if result.get("status") != "ok":
            raise RuntimeInvalidRequestError(
                f"Claude executable validation failed: {result.get('reason') or result.get('status')}"
            )
        return target
    return discovered_target


def claude_candidate_targets() -> tuple[LaunchTarget, ...]:
    names = ("claude.cmd", "claude.exe") if sys.platform == "win32" else ("claude",)
    targets: list[LaunchTarget] = []
    configured = os.environ.get("CLAUDE_BIN")
    if configured:
        targets.append(launch_target("env", configured))
    for name in names:
        resolved = shutil.which(name)
        if resolved:
            targets.append(launch_target("path", resolved))
    home = Path.home()
    for candidate in (
        home / ".claude" / "local" / "claude",
        home / ".npm-global" / "bin" / "claude",
    ):
        targets.append(launch_target("common", str(candidate)))
    return tuple(dict.fromkeys(targets))


def check_claude_target(
    target: LaunchTarget,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    _ = environment
    path = os.path.expanduser(os.path.expandvars(target.path))
    if not Path(path).exists() and shutil.which(path) is None:
        return {
            "status": "missing",
            "source": target.source,
            "path": target.path,
            "reason": "file not found",
        }
    return {
        "status": "ok",
        "source": target.source,
        "path": target.path,
    }


def target_metadata(target: LaunchTarget | None) -> dict[str, Any] | None:
    if target is None:
        return None
    return {"source": target.source, "path": target.path}
