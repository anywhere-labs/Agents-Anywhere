"""Find and stop the Codex desktop app process.

On macOS the Codex desktop app ships inside ChatGPT.app; a standalone
Codex.app exists as well. The main process is what owns the IPC windows and the
app-server that holds thread writer locks, so stopping it releases every thread
the app had loaded. Helper processes (renderers, node sidecars) are children of
the main process and go away with it.
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field

from connector.logging import logger

PROBE_TIMEOUT = 5.0
DEFAULT_GRACE_PERIOD = 5.0

# Executable path suffixes of the desktop app's main process per platform.
DESKTOP_PROCESS_MARKERS: dict[str, tuple[str, ...]] = {
    "darwin": ("/ChatGPT.app/Contents/MacOS/ChatGPT", "/Codex.app/Contents/MacOS/Codex"),
    "linux": ("/chatgpt", "/codex-desktop", "/Codex"),
}


@dataclass(frozen=True, slots=True)
class DesktopAppShutdown:
    terminated: tuple[int, ...] = ()
    killed: tuple[int, ...] = ()
    survivors: tuple[int, ...] = ()
    details: dict[str, object] = field(default_factory=dict)

    @property
    def found(self) -> bool:
        return bool(self.terminated or self.killed or self.survivors)

    @property
    def ok(self) -> bool:
        return self.found and not self.survivors


def supported(platform: str = sys.platform) -> bool:
    return platform in DESKTOP_PROCESS_MARKERS


def desktop_process_listed(listing: str, markers: Sequence[str]) -> bool:
    return any(
        any(line.rstrip().endswith(marker) for marker in markers)
        for line in listing.splitlines()
    )


def desktop_pids_from_listing(listing: str, markers: Sequence[str]) -> tuple[int, ...]:
    """Parse ``ps -axo pid=,comm=`` (or ``comm=`` only) output into matching pids."""

    pids: list[int] = []
    for line in listing.splitlines():
        line = line.rstrip()
        if not any(line.endswith(marker) for marker in markers):
            continue
        head, _, _ = line.strip().partition(" ")
        if head.isdigit():
            pids.append(int(head))
    return tuple(pids)


async def _process_listing(timeout: float) -> str | None:
    try:
        process = await asyncio.create_subprocess_exec(
            "ps",
            "-axo",
            "pid=,comm=",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout)
    except (OSError, TimeoutError) as exc:
        logger.debug("codex desktop app probe failed error={}", exc)
        return None
    if process.returncode != 0:
        return None
    return stdout.decode(errors="replace")


async def desktop_app_pids(*, timeout: float = PROBE_TIMEOUT) -> tuple[int, ...] | None:
    """Return the main-process pids of running desktop apps; None when unknown."""

    markers = DESKTOP_PROCESS_MARKERS.get(sys.platform)
    if not markers:
        return None
    listing = await _process_listing(timeout)
    if listing is None:
        return None
    return desktop_pids_from_listing(listing, markers)


async def desktop_app_running(*, timeout: float = PROBE_TIMEOUT) -> bool | None:
    """Return whether a Codex desktop app process exists; None when unknown."""

    pids = await desktop_app_pids(timeout=timeout)
    return None if pids is None else bool(pids)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A child of ours that already exited lingers as a zombie until reaped.
    try:
        reaped, _ = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return True
    return reaped == 0


async def quit_desktop_app(
    *,
    grace_period: float = DEFAULT_GRACE_PERIOD,
    timeout: float = PROBE_TIMEOUT,
) -> DesktopAppShutdown:
    """Stop every desktop app main process: SIGTERM, then SIGKILL after ``grace_period``.

    Side effects: the ChatGPT / Codex desktop app exits, every thread it had
    loaded loses its IPC owner and its writer lock is released.
    """

    pids = await desktop_app_pids(timeout=timeout)
    if not pids:
        return DesktopAppShutdown(details={"platform": sys.platform, "found": False})
    terminated: list[int] = []
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
            terminated.append(pid)
        except ProcessLookupError:
            continue
        except PermissionError as exc:
            logger.warning("codex desktop app terminate denied pid={} error={}", pid, exc)
    deadline = asyncio.get_running_loop().time() + grace_period
    remaining = [pid for pid in pids if _alive(pid)]
    while remaining and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.2)
        remaining = [pid for pid in remaining if _alive(pid)]
    killed: list[int] = []
    for pid in remaining:
        try:
            os.kill(pid, signal.SIGKILL)
            killed.append(pid)
        except ProcessLookupError:
            continue
        except PermissionError as exc:
            logger.warning("codex desktop app kill denied pid={} error={}", pid, exc)
    await asyncio.sleep(0.2)
    survivors = tuple(pid for pid in pids if _alive(pid))
    result = DesktopAppShutdown(
        terminated=tuple(pid for pid in terminated if pid not in killed),
        killed=tuple(killed),
        survivors=survivors,
        details={"platform": sys.platform, "found": True},
    )
    logger.info(
        "codex desktop app stopped terminated={} killed={} survivors={}",
        result.terminated,
        result.killed,
        result.survivors,
    )
    return result
