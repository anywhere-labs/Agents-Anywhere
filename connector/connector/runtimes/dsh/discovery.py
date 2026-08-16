from __future__ import annotations

import asyncio
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from connector.launch import LaunchTarget, launch_target
from connector.runtimes.dsh.provider_config import child_environment


@dataclass(frozen=True, slots=True)
class DshDiscovery:
    available: bool
    configured: bool
    target: LaunchTarget | None
    version: str | None = None
    bridge_version: str | None = None
    reason: str | None = None
    metadata: dict[str, Any] | None = None


def resolve_target(
    values: dict[str, Any],
    environment: dict[str, str] | None = None,
) -> LaunchTarget | None:
    configured = values.get("executablePath")
    if isinstance(configured, str) and configured:
        path = str(Path(configured).expanduser())
        if not Path(path).is_file() or (os.name != "nt" and not os.access(path, os.X_OK)):
            return None
        return launch_target("configured", path)
    found = shutil.which(
        "dsh",
        path=(environment or child_environment(values)).get("PATH"),
    )
    return launch_target("path", found) if found else None


async def discover(values: dict[str, Any]) -> DshDiscovery:
    environment = child_environment(values)
    target = resolve_target(values, environment)
    if target is None:
        reason = "configured DSH executable is missing or not executable" if values.get("executablePath") else "dsh executable was not found on PATH"
        return DshDiscovery(False, False, None, reason=reason)
    timeout = values["startupTimeoutMs"] / 1000
    version_result = await _probe(target, ("--version",), environment, timeout)
    if version_result[0] != 0:
        return DshDiscovery(False, False, target, reason="dsh --version failed")
    version = _first_nonempty_line(version_result[1])
    profile = values["profile"]
    default_dump = await _probe(
        target,
        ("--profile", profile, "--dump-default-config"),
        environment,
        timeout,
    )
    if default_dump[0] != 0:
        return DshDiscovery(False, False, target, version=version, reason=f"DSH profile {profile!r} is unavailable or invalid")
    if "agents-anywhere-bridge" not in default_dump[1]:
        return DshDiscovery(False, False, target, version=version, reason=f"DSH profile {profile!r} does not contain the Agents Anywhere bridge")
    effective_dump = await _probe(
        target,
        ("--profile", profile, "--dump-config"),
        environment,
        timeout,
    )
    if effective_dump[0] != 0:
        return DshDiscovery(False, False, target, version=version, reason=f"DSH profile {profile!r} effective config is invalid")
    required = ("agents-anywhere-bridge", "session-persistence", "agents")
    missing = [item for item in required if item not in effective_dump[1]]
    if missing:
        return DshDiscovery(False, False, target, version=version, reason="DSH profile is missing required services")
    return DshDiscovery(
        True,
        True,
        target,
        version=version,
        metadata={
            "executable": Path(target.path).name,
            "profile": profile,
            "storageMode": "dsh-native",
            "sameSessionWriterLimit": 1,
            "crossProcessWriterExclusion": False,
        },
    )


async def _probe(
    target: LaunchTarget,
    args: tuple[str, ...],
    environment: dict[str, str],
    timeout: float,
) -> tuple[int, str, str]:
    try:
        process = await asyncio.create_subprocess_exec(
            *target.command(args),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
    except TimeoutError:
        if "process" in locals():
            process.kill()
            await process.wait()
        return 124, "", "probe timed out"
    return process.returncode or 0, _decode_limited(stdout), _decode_limited(stderr)


def _decode_limited(value: bytes, limit: int = 262_144) -> str:
    return value[:limit].decode("utf-8", errors="replace")


def _first_nonempty_line(value: str) -> str | None:
    return next((line.strip() for line in value.splitlines() if line.strip()), None)
