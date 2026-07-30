from __future__ import annotations

import time
from collections.abc import Callable


def _unix_time_microseconds() -> int:
    return time.time_ns() // 1_000


class ProtocolRevisionClock:
    def __init__(self, source: Callable[[], int] = _unix_time_microseconds) -> None:
        self._source = source
        self._last = 0

    def next(self) -> int:
        candidate = self._source()
        self._last = max(candidate, self._last + 1)
        return self._last
