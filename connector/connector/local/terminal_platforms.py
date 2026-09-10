from __future__ import annotations

import errno
import os
import signal
import sys
from pathlib import Path
from typing import Any

from connector.local.common import Notify
from connector.local.terminal import TerminalBackend


class UnixPtyTerminalBackend(TerminalBackend):
    def _spawn(self, argv: list[str], *, cwd: Path, env: dict[str, str], rows: int, cols: int) -> Any:
        import ptyprocess

        try:
            return ptyprocess.PtyProcess.spawn(
                argv,
                cwd=str(cwd),
                env=env,
                dimensions=(rows, cols),
            )
        except FileNotFoundError as exc:
            raise FileNotFoundError(f"terminal command not found: {argv[0]}") from exc

    def _read(self, pty: Any) -> bytes:
        try:
            chunk = os.read(pty.fd, 4096)
        except OSError as exc:
            if exc.errno in (errno.EIO,):
                return b""
            raise
        return chunk

    def _write_all(self, pty: Any, data: bytes) -> None:
        written = 0
        while written < len(data):
            try:
                n = os.write(pty.fd, data[written:])
            except OSError as exc:
                if exc.errno in (errno.EIO, errno.EPIPE):
                    return
                raise
            if not n:
                return
            written += n

    def _setwinsize(self, pty: Any, rows: int, cols: int) -> None:
        pty.setwinsize(rows, cols)

    def _terminate(self, pty: Any) -> None:
        try:
            pty.terminate(force=True)
        except Exception:
            try:
                pty.kill(signal.SIGKILL)
            except Exception:
                pass

    def _close(self, pty: Any) -> None:
        try:
            pty.close(force=True)
        except Exception:
            pass

    def _wait_exit_code(self, pty: Any) -> int | None:
        try:
            pty.wait()
            return pty.exitstatus
        except Exception:
            return None


class WinPtyTerminalBackend(TerminalBackend):
    def _default_shell(self, requested: Any) -> str:
        if isinstance(requested, str) and requested.strip():
            return requested
        return "powershell.exe"

    def _default_argv(self, shell_cmd: str) -> list[str]:
        if shell_cmd.lower().endswith("powershell.exe") or shell_cmd.lower() == "powershell":
            return [shell_cmd, "-NoLogo"]
        return [shell_cmd]

    def _spawn(self, argv: list[str], *, cwd: Path, env: dict[str, str], rows: int, cols: int) -> Any:
        try:
            from winpty import PtyProcess
        except ImportError as exc:
            raise RuntimeError("pywinpty is required for Windows terminal support") from exc
        try:
            return PtyProcess.spawn(
                argv,
                cwd=str(cwd),
                env=env,
                dimensions=(rows, cols),
            )
        except Exception as exc:
            raise RuntimeError(
                "failed to create Windows ConPTY terminal; run the connector in an interactive user session"
            ) from exc

    def _read(self, pty: Any) -> bytes:
        try:
            data = pty.read(4096)
        except EOFError:
            return b""
        if isinstance(data, str):
            return data.encode("utf-8", errors="replace")
        return data or b""

    def _write_all(self, pty: Any, data: bytes) -> None:
        pty.write(data.decode("utf-8", errors="replace"))

    def _setwinsize(self, pty: Any, rows: int, cols: int) -> None:
        pty.setwinsize(rows, cols)

    def _terminate(self, pty: Any) -> None:
        try:
            pty.terminate(force=True)
        except Exception:
            try:
                pty.kill()
            except Exception:
                pass

    def _close(self, pty: Any) -> None:
        try:
            pty.close()
        except Exception:
            pass

    def _wait_exit_code(self, pty: Any) -> int | None:
        try:
            pty.wait()
            return pty.exitstatus
        except Exception:
            return None


def default_terminal_backend(notify: Notify | None = None) -> TerminalBackend:
    if sys.platform == "win32":
        return WinPtyTerminalBackend(notify=notify)
    return UnixPtyTerminalBackend(notify=notify)
