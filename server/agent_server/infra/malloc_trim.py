"""Hand freed glibc heap memory back to the kernel on a fixed interval.

Long-running Server workers churn through many medium-sized strings (timeline
JSON, notification payloads). glibc keeps the freed space inside the process
heap, so resident memory creeps up over hours even though Python no longer
holds the objects (#466). ``malloc_trim(0)`` returns those free pages.

The loop is opt-in through ``AGENT_SERVER_MALLOC_TRIM_INTERVAL_SECONDS`` and is
a no-op on platforms without glibc's ``malloc_trim`` (macOS, musl).
"""

from __future__ import annotations

import asyncio
import ctypes
import os
import sys
import time
from collections.abc import Awaitable, Callable

from loguru import logger

# Trims slower than this are logged at info level so operators can see the cost.
SLOW_TRIM_SECONDS = 0.1

MallocTrim = Callable[[], int]


def load_malloc_trim() -> MallocTrim | None:
    """Return a callable running ``malloc_trim(0)``, or None when unavailable."""

    if not sys.platform.startswith("linux"):
        return None
    try:
        libc = ctypes.CDLL("libc.so.6")
    except OSError:
        return None
    function = getattr(libc, "malloc_trim", None)
    if function is None:
        return None
    function.argtypes = [ctypes.c_size_t]
    function.restype = ctypes.c_int

    def trim() -> int:
        return int(function(0))

    return trim


def resident_bytes() -> int | None:
    """Current resident set size from ``/proc``, or None outside Linux."""

    try:
        with open("/proc/self/statm", encoding="ascii") as statm:
            pages = int(statm.read().split()[1])
    except (OSError, IndexError, ValueError):
        return None
    return pages * os.sysconf("SC_PAGE_SIZE")


async def run_malloc_trim_loop(
    interval_seconds: float,
    *,
    trim: MallocTrim | None = None,
    sleep: Callable[[float], Awaitable[object]] = asyncio.sleep,
    rss: Callable[[], int | None] = resident_bytes,
) -> None:
    """Call ``malloc_trim(0)`` every ``interval_seconds`` until cancelled."""

    trim = trim if trim is not None else load_malloc_trim()
    if trim is None:
        logger.warning(
            "AGENT_SERVER_MALLOC_TRIM_INTERVAL_SECONDS is set but malloc_trim is "
            "not available on this platform; periodic trimming is disabled"
        )
        return
    logger.info("periodic malloc_trim enabled interval_seconds={}", interval_seconds)
    while True:
        await sleep(interval_seconds)
        try:
            await _trim_once(trim, rss)
        except Exception:  # noqa: BLE001 - a failed trim must not stop the loop
            logger.exception("malloc_trim failed")


async def _trim_once(trim: MallocTrim, rss: Callable[[], int | None]) -> None:
    before = rss()
    started = time.monotonic()
    # ctypes releases the GIL; running in a thread keeps the event loop serving.
    released = await asyncio.to_thread(trim)
    elapsed = time.monotonic() - started
    after = rss()
    log = logger.info if elapsed >= SLOW_TRIM_SECONDS else logger.debug
    log(
        "malloc_trim released={} rss_before_mib={} rss_after_mib={} elapsed_ms={:.1f}",
        bool(released),
        _mib(before),
        _mib(after),
        elapsed * 1000,
    )


def _mib(value: int | None) -> str:
    return "unknown" if value is None else f"{value / 2**20:.1f}"
