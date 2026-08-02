from __future__ import annotations

import asyncio
import importlib
import os
import shutil
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from connector.launch import LaunchTarget, launch_target, path_exists_for_launch
from connector.codex.rpc import codex_candidate_paths


_COMMAND_CHECK_TIMEOUT_S = 8.0


async def discover_codex_capability(
    *, extra_candidate: str | None = None
) -> tuple[dict[str, Any], LaunchTarget | None]:
    """Scan the local machine for a usable Codex install.

    `extra_candidate`, when set, is checked first as `source="custom"`. Used
    by the per-runtime scan endpoint when the user types a custom path in the
    Add Agent modal.
    """
    candidates = codex_candidate_paths()
    if extra_candidate:
        candidates = _dedupe_candidates(
            [{"source": "custom", "path": extra_candidate}, *candidates]
        )
    checked: list[dict[str, Any]] = []
    for candidate in candidates:
        target = _target_from_candidate(candidate)
        result = await check_codex_target(candidate)
        checked.append(result)
        if result["status"] == "ok":
            return (
                {
                    "history": "ok",
                    "execution": "ok",
                    "selected": _selected_from_check(result),
                    "checked": checked,
                },
                target,
            )
    return (
        {
            "history": "unavailable",
            "execution": "unavailable",
            "error": {
                "code": "codex_unavailable",
                "message": (
                    "Codex is unavailable or broken. Checked custom path, Codex App, "
                    "and Codex CLI. Plugin-based Codex installations are not supported yet."
                ),
            },
            "checked": checked,
        },
        None,
    )


async def discover_claude_capability(
    *, extra_candidate: str | None = None
) -> tuple[dict[str, Any], LaunchTarget | None]:
    history = _check_claude_history()
    candidates = _claude_candidate_paths()
    if extra_candidate:
        candidates = _dedupe_candidates(
            [{"source": "custom", "path": extra_candidate}, *candidates]
        )
    checked: list[dict[str, Any]] = []
    selected_target: LaunchTarget | None = None
    execution = "unavailable"
    for candidate in candidates:
        target = _target_from_candidate(candidate)
        result = await check_claude_target(candidate)
        checked.append(result)
        if result["status"] == "ok":
            selected_target = target
            execution = "ok"
            break

    report: dict[str, Any] = {
        "history": history["status"],
        "execution": execution,
        "historyCheck": history,
        "checked": checked,
    }
    if selected_target is not None:
        report["selected"] = _selected_from_check(checked[-1])
    else:
        report["error"] = {
            "code": "claude_cli_unavailable",
            "message": "Claude Code is unavailable or broken. Checked CLAUDE_BIN, PATH, and common install paths.",
        }
    return report, selected_target


async def check_codex_target(
    candidate: dict[str, str] | LaunchTarget,
    *,
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    target = _target_from_candidate(candidate)
    path = target.path
    source = target.source
    base = {"source": source, "path": path}
    if not Path(path).is_file():
        return {**base, "status": "missing", "reason": "file not found"}
    if not path_exists_for_launch(path):
        return {**base, "status": "failed", "reason": "not executable"}

    version = await _run_command(target.command(["--version"]), environment=environment)
    if version["status"] != "ok":
        return {**base, "status": "failed", "stage": "version", **version}
    return {
        **base,
        "status": "ok",
        "version": version.get("stdout"),
    }


async def check_claude_target(
    candidate: dict[str, str] | LaunchTarget,
    *,
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    target = _target_from_candidate(candidate)
    path = target.path
    source = target.source
    base = {"source": source, "path": path}
    if not Path(path).is_file():
        return {**base, "status": "missing", "reason": "file not found"}
    if not path_exists_for_launch(path):
        return {**base, "status": "failed", "reason": "not executable"}

    version = await _run_command(target.command(["--version"]), environment=environment)
    if version["status"] != "ok":
        return {**base, "status": "failed", "stage": "version", **version}
    help_result = await _run_command(target.command(["--help"]), environment=environment)
    if help_result["status"] != "ok":
        return {
            **base,
            "status": "failed",
            "stage": "help",
            "version": version.get("stdout"),
            "reason": help_result.get("reason"),
        }
    return {**base, "status": "ok", "version": version.get("stdout")}


def _check_claude_history() -> dict[str, Any]:
    source = "claude-agent-sdk"
    api = "list_sessions"
    try:
        sessions = _list_claude_sdk_sessions()
    except Exception as exc:
        return {
            "status": "unavailable",
            "source": source,
            "api": api,
            "reason": _exception_reason(exc),
        }
    return {
        "status": "ok" if sessions else "ok_empty",
        "source": source,
        "api": api,
        "sessionCount": len(sessions),
    }


def _list_claude_sdk_sessions() -> list[Any]:
    sdk = importlib.import_module("claude_agent_sdk")
    list_sessions = getattr(sdk, "list_sessions")
    return list(list_sessions())


async def _run_command(
    command: list[str],
    *,
    environment: dict[str, str] | None = None,
) -> dict[str, Any]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=_COMMAND_CHECK_TIMEOUT_S)
    except Exception as exc:
        return {"status": "failed", "reason": _exception_reason(exc)}
    out = stdout.decode(errors="replace").strip()
    err = stderr.decode(errors="replace").strip()
    if proc.returncode != 0:
        return {
            "status": "failed",
            "reason": f"exit {proc.returncode}",
            "stdout": out[:500],
            "stderr": err[:500],
        }
    return {"status": "ok", "stdout": out[:500], "stderr": err[:500]}


def _claude_candidate_paths() -> list[dict[str, str]]:
    if sys.platform == "win32":
        home = Path.home()
        appdata = os.environ.get("APPDATA", str(home / "AppData" / "Roaming"))
        return _dedupe_candidates(
            [
                {"source": "custom", "path": os.environ.get("CLAUDE_BIN", "")},
                {"source": "cli", "path": shutil.which("claude") or ""},
                *[
                    {"source": "cli", "path": str(home / ".local" / "bin" / name)}
                    for name in ("claude.exe", "claude.cmd", "claude.ps1")
                ],
                *[
                    {"source": "npm", "path": str(Path(appdata) / "npm" / name)}
                    for name in ("claude.cmd", "claude.ps1", "claude.exe")
                ],
                *[
                    {"source": "npm", "path": str(home / ".npm-global" / "bin" / name)}
                    for name in ("claude.cmd", "claude.ps1", "claude.exe")
                ],
                *[
                    {"source": "nvm", "path": str(Path("C:/nvm4w/nodejs") / name)}
                    for name in ("claude.cmd", "claude.ps1", "claude.exe")
                ],
                *[
                    {"source": "scoop", "path": str(home / "scoop" / "shims" / name)}
                    for name in ("claude.exe", "claude.cmd", "claude.ps1")
                ],
            ]
        )
    return _dedupe_candidates(
        [
            {"source": "custom", "path": os.environ.get("CLAUDE_BIN", "")},
            {"source": "cli", "path": shutil.which("claude") or ""},
            {"source": "cli", "path": str(Path.home() / ".npm-global" / "bin" / "claude")},
            {"source": "cli", "path": str(Path.home() / ".local" / "bin" / "claude")},
            {"source": "cli", "path": "/opt/homebrew/bin/claude"},
            {"source": "cli", "path": "/usr/local/bin/claude"},
        ]
    )


def _target_from_candidate(candidate: dict[str, str] | LaunchTarget) -> LaunchTarget:
    if isinstance(candidate, LaunchTarget):
        return candidate
    return launch_target(candidate["source"], candidate["path"])


def _dedupe_candidates(candidates: Iterable[dict[str, str]]) -> list[dict[str, str]]:
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for candidate in candidates:
        path = candidate.get("path") or ""
        if not path or path in seen:
            continue
        seen.add(path)
        out.append(candidate)
    return out


def _selected_from_check(result: dict[str, Any]) -> dict[str, Any]:
    selected = {
        "source": result["source"],
        "path": result["path"],
    }
    if result.get("version"):
        selected["version"] = result["version"]
    return selected


def _exception_reason(exc: BaseException) -> str:
    if isinstance(exc, TimeoutError):
        return "timeout"
    return str(exc) or exc.__class__.__name__

