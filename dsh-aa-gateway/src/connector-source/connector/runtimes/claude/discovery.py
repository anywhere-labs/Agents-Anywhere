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

SdkLoader = Callable[[], Any]
CommandChecker = Callable[[LaunchTarget, Mapping[str, str]], dict[str, Any]]


def load_claude_sdk() -> Any:
    return importlib.import_module("claude_agent_sdk")


def check_claude_sdk(loader: SdkLoader) -> dict[str, Any]:
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
    if not isinstance(version, str) or not version:
        try:
            version = importlib.metadata.version("claude-agent-sdk")
        except importlib.metadata.PackageNotFoundError:
            version = None

    return {
        "available": True,
        "package": "claude-agent-sdk",
        **({"version": version} if isinstance(version, str) and version else {}),
    }


def claude_candidate_targets() -> tuple[LaunchTarget, ...]:
    names = ("claude.cmd", "claude.exe") if sys.platform == "win32" else ("claude",)
    candidates: list[tuple[str, str]] = []
    configured = os.environ.get("CLAUDE_BIN")
    if configured:
        candidates.append(("env", configured))
    for name in names:
        resolved = shutil.which(name)
        if resolved:
            candidates.append(("path", resolved))
    home = Path.home()
    candidates.extend(
        [
            ("common", str(home / ".claude" / "local" / "claude")),
            ("common", str(home / ".npm-global" / "bin" / "claude")),
        ]
    )

    seen: set[str] = set()
    targets: list[LaunchTarget] = []
    for source, raw in candidates:
        path = os.path.expandvars(os.path.expanduser(raw))
        if not path or path in seen:
            continue
        seen.add(path)
        targets.append(launch_target(source, path))
    return tuple(targets)


def check_claude_target(
    target: LaunchTarget,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    _ = environment
    path = os.path.expandvars(os.path.expanduser(target.path))
    if Path(path).is_file():
        return {
            "status": "ok",
            "source": target.source,
            "path": target.path,
            "launcher": target.launcher,
        }
    if shutil.which(path) is not None:
        return {
            "status": "ok",
            "source": target.source,
            "path": target.path,
            "launcher": target.launcher,
        }
    return {
        "status": "missing",
        "source": target.source,
        "path": target.path,
        "reason": "file not found",
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


def target_metadata(target: LaunchTarget | None) -> dict[str, Any] | None:
    if target is None:
        return None
    return {
        "source": target.source,
        "path": target.path,
        "launcher": target.launcher,
    }
