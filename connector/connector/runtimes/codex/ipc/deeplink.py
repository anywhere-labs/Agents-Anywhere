"""Hand a thread to the running Codex desktop app through its deep link.

The desktop app (shipped inside ChatGPT.app on macOS, Codex.app elsewhere)
registers the ``codex://`` URL scheme. Opening ``codex://threads/<thread-id>``
makes the running app navigate to that thread, resume it in its app-server and
register itself as the IPC owner, after which the follower can discover it in
milliseconds. This module only knows how to build and open that URL and how to
tell whether a desktop app is running; the runtime decides when to use it.
"""

from __future__ import annotations

import asyncio
import os
import re
import sys
from collections.abc import Sequence

from connector.logging import logger
from connector.runtimes.codex.ipc.desktop_app import (  # noqa: F401 - re-exported
    DESKTOP_PROCESS_MARKERS,
    desktop_app_running,
    desktop_process_listed,
)

THREAD_ID_RE = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
OPEN_TIMEOUT = 5.0

def thread_deeplink(thread_id: str) -> str:
    """Return ``codex://threads/<thread_id>``; thread ids must be UUID-shaped."""

    if not isinstance(thread_id, str) or not THREAD_ID_RE.match(thread_id):
        raise ValueError(f"not a Codex thread id: {thread_id!r}")
    return f"codex://threads/{thread_id.lower()}"


def deeplink_supported(platform: str = sys.platform) -> bool:
    return platform in {"darwin", "linux", "win32"}


def opener_command(url: str, platform: str = sys.platform) -> Sequence[str] | None:
    """Return the argv that asks the OS to open ``url`` without stealing focus."""

    if platform == "darwin":
        return ("open", "-g", url)
    if platform == "linux":
        return ("xdg-open", url)
    return None


async def open_deeplink(url: str, *, timeout: float = OPEN_TIMEOUT) -> bool:
    """Ask the OS to open ``url``; True when the opener accepted it."""

    if sys.platform == "win32":
        try:
            os.startfile(url)  # type: ignore[attr-defined]
        except OSError as exc:
            logger.warning("codex deeplink open failed url={} error={}", url, exc)
            return False
        return True
    argv = opener_command(url)
    if argv is None:
        return False
    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(process.communicate(), timeout)
    except (TimeoutError, OSError) as exc:
        logger.warning("codex deeplink open failed url={} error={}", url, exc)
        return False
    if process.returncode != 0:
        logger.warning(
            "codex deeplink opener exited code={} url={} stderr={}",
            process.returncode,
            url,
            stderr.decode(errors="replace").strip(),
        )
        return False
    return True
