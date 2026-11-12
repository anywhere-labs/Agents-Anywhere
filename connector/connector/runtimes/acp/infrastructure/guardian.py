"""POSIX process-group guardian. No protocol parsing and no stdout diagnostics."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time


def main() -> None:
    parent = int(sys.argv[1])
    if os.getppid() != parent:
        return
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    child = subprocess.Popen(
        sys.argv[2:],
        stdin=sys.stdin.buffer,
        stdout=sys.stdout.buffer,
        stderr=sys.stderr.buffer,
    )
    while child.poll() is None and not stopping and os.getppid() == parent:
        time.sleep(0.05)
    # Include all inherited descendants. The guardian stays alive through TERM
    # so children that ignore it cannot outlive ownership release.
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    os.killpg(os.getpgrp(), signal.SIGTERM)
    time.sleep(0.25)
    os.killpg(os.getpgrp(), signal.SIGKILL)


if __name__ == "__main__":
    main()
