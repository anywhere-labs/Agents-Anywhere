"""PtyRunner smoke tests — exercise spawn / send / read / terminate against
a real subprocess (`bash -c`). Avoids depending on `claude` actually being
installed so this passes everywhere."""

from __future__ import annotations

import sys
import time

import pytest

from connector.claude.pty_runner import PtyRunner, PtyDimensions


if sys.platform == "win32":  # pragma: no cover
    pytest.skip("PtyRunner unix tests skipped on Windows", allow_module_level=True)


def _drain(runner: PtyRunner, deadline_s: float = 2.0) -> bytes:
    blob = b""
    end = time.monotonic() + deadline_s
    while time.monotonic() < end:
        chunk = runner.read_nonblocking(size=4096, timeout=0.1)
        if not chunk:
            if not runner.isalive():
                break
            continue
        blob += chunk
    return blob


def test_spawn_send_read_terminate() -> None:
    runner = PtyRunner()
    runner.spawn("/bin/bash", ["-lc", "cat"], dimensions=PtyDimensions(rows=24, cols=80))
    try:
        assert runner.isalive()
        runner.send(b"hello world\n")
        out = _drain(runner, deadline_s=1.5)
        assert b"hello world" in out
    finally:
        runner.terminate(force=True)


def test_send_ctrl_c_exits() -> None:
    runner = PtyRunner()
    # python -c with `input()` is a reliable SIGINT receiver in a PTY.
    runner.spawn(
        sys.executable,
        ["-c", "import sys; input(); print('done')"],
    )
    try:
        time.sleep(0.2)  # let interpreter reach input()
        runner.send_ctrl_c()
        # Poll for exit up to 2s.
        for _ in range(40):
            if not runner.isalive():
                break
            time.sleep(0.05)
        assert not runner.isalive()
    finally:
        runner.terminate(force=True)


def test_send_esc_does_not_kill() -> None:
    runner = PtyRunner()
    runner.spawn("/bin/bash", ["-lc", "cat"])
    try:
        runner.send_esc()
        time.sleep(0.2)
        # ESC is just a byte in the input stream — cat is still alive.
        assert runner.isalive()
    finally:
        runner.terminate(force=True)


def test_double_spawn_raises() -> None:
    runner = PtyRunner()
    runner.spawn("/bin/bash", ["-lc", "true"])
    try:
        with pytest.raises(RuntimeError):
            runner.spawn("/bin/bash", ["-lc", "true"])
    finally:
        runner.terminate(force=True)


def test_read_when_not_spawned_returns_empty() -> None:
    runner = PtyRunner()
    assert runner.read_nonblocking() == b""
    assert runner.isalive() is False
    runner.terminate()  # no-op
