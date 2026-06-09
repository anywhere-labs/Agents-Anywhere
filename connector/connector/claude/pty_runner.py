"""Cross-platform PTY abstraction for spawning the Claude TUI.

The Claude write path can't talk to claude over JSON-RPC the way Codex does;
instead we drive its terminal UI. macOS/Linux use `pexpect`, Windows uses
`pywinpty` (ConPTY). This module hides the differences behind one shape.

Only the calls we actually need for Task 4-5 are exposed:

  - spawn(cmd, args, cwd, env, dimensions)
  - send(text)
  - send_enter() / send_esc() / send_ctrl_c()
  - read_nonblocking(size, timeout) -> bytes
  - isalive() / terminate(force)

Approval-screen scraping (Task 5) sits on top via a continuously-running
reader thread; that's outside this file.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Any

from connector.launch import LaunchTarget


if sys.platform == "win32":  # pragma: no cover - exercised on Windows only
    try:
        from winpty import PtyProcess as _WinPtyProcess
    except ImportError:  # pragma: no cover
        _WinPtyProcess = None  # type: ignore[assignment]


@dataclass(slots=True)
class PtyDimensions:
    rows: int = 40
    cols: int = 140


class PtyRunner:
    """One spawned child + the bytes you can shove at it.

    Construct, call `spawn(...)` once, then use `send_*` / `read_nonblocking`
    until you're done. `terminate()` (or `send_ctrl_c()` twice for a clean
    TUI exit) at the end.
    """

    def __init__(self) -> None:
        self._child: Any = None

    def spawn(
        self,
        cmd: str | LaunchTarget,
        args: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        dimensions: PtyDimensions | None = None,
    ) -> None:
        if self._child is not None:
            raise RuntimeError("PtyRunner already spawned; create a new instance")
        dim = dimensions or PtyDimensions()
        merged_env = {**os.environ, **(env or {})}
        # claude expects a real terminal; without TERM set the TUI doesn't
        # render cleanly. xterm-256color is what the research doc confirmed.
        merged_env.setdefault("TERM", "xterm-256color")

        if isinstance(cmd, LaunchTarget):
            command = cmd.command(args)
        else:
            command = [cmd, *args]

        if sys.platform == "win32":  # pragma: no cover - Windows-only branch
            if _WinPtyProcess is None:
                raise RuntimeError(
                    "pywinpty is not installed; add it via "
                    "`pip install pywinpty` for Windows"
                )
            self._child = _WinPtyProcess.spawn(
                command,
                cwd=cwd,
                env=merged_env,
                dimensions=(dim.rows, dim.cols),
            )
        else:
            import pexpect

            self._child = pexpect.spawn(
                command[0],
                command[1:],
                cwd=cwd,
                env=merged_env,
                dimensions=(dim.rows, dim.cols),
                encoding=None,  # bytes mode — caller decodes
                timeout=None,
            )

    def send(self, data: str | bytes) -> None:
        payload = data.encode("utf-8") if isinstance(data, str) else data
        if sys.platform == "win32":  # pragma: no cover
            assert self._child is not None
            self._child.write(payload.decode("utf-8", errors="replace"))
        else:
            assert self._child is not None
            self._child.send(payload)

    def send_enter(self) -> None:
        self.send(b"\r")

    def send_esc(self) -> None:
        """Interrupt the current in-flight turn (research doc §10.4)."""
        self.send(b"\x1b")

    def send_ctrl_c(self) -> None:
        """One Ctrl+C — TUI shows 'Press Ctrl-C again to exit'.
        Two in a row exits cleanly; call this twice for shutdown."""
        self.send(b"\x03")

    def read_nonblocking(self, size: int = 4096, timeout: float = 0.0) -> bytes:
        """Read up to `size` bytes. Returns b"" on timeout."""
        if self._child is None:
            return b""
        if sys.platform == "win32":  # pragma: no cover
            try:
                data = self._child.read(size)
            except EOFError:
                return b""
            if isinstance(data, str):
                return data.encode("utf-8", errors="replace")
            return data
        import pexpect

        try:
            data = self._child.read_nonblocking(size=size, timeout=timeout)
        except pexpect.TIMEOUT:
            return b""
        except pexpect.EOF:
            return b""
        if isinstance(data, str):
            return data.encode("utf-8", errors="replace")
        return data

    def isalive(self) -> bool:
        if self._child is None:
            return False
        if sys.platform == "win32":  # pragma: no cover
            return bool(self._child.isalive())
        return bool(self._child.isalive())

    def terminate(self, *, force: bool = False) -> None:
        if self._child is None:
            return
        try:
            if sys.platform == "win32":  # pragma: no cover
                self._child.terminate(force=force)
            else:
                self._child.terminate(force=force)
        finally:
            self._child = None

    @property
    def pid(self) -> int | None:
        if self._child is None:
            return None
        return getattr(self._child, "pid", None)
