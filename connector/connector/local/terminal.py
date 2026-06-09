from __future__ import annotations

import asyncio
import base64
import errno
import os
import signal
import sys
from pathlib import Path
from typing import Any

from connector.local.common import Notify, nearest_existing_dir, required_string, resolve_path, workspace_root


class TerminalBackend:
    def __init__(self, notify: Notify | None = None) -> None:
        self.notify = notify
        self._terminals: dict[str, dict[str, Any]] = {}

    async def create(self, params: dict[str, Any]) -> dict[str, Any]:
        root = workspace_root(params)
        raw_cwd = params.get("cwd")
        if isinstance(raw_cwd, str) and raw_cwd.strip():
            cwd = resolve_path(root, raw_cwd)
        else:
            cwd = root
        cwd = nearest_existing_dir(cwd, fallback=root)
        terminal_id = required_string(params, "terminalId")
        session_id = required_string(params, "sessionId")
        cols = int(params.get("cols") or 80)
        rows = int(params.get("rows") or 24)
        command = params.get("command")
        raw_args = params.get("args")
        if command is not None and not isinstance(command, str):
            raise ValueError("command must be a string")
        args: list[str] = []
        if raw_args is not None:
            if not isinstance(raw_args, list) or not all(isinstance(arg, str) for arg in raw_args):
                raise ValueError("args must be a list of strings")
            args = list(raw_args)
        shell_cmd = self._default_shell(params.get("shell"))
        argv = [command, *args] if isinstance(command, str) and command.strip() else self._default_argv(shell_cmd)
        env_override = params.get("env") or {}
        env = {**os.environ}
        env.setdefault("TERM", "xterm-256color")
        env.setdefault("COLORTERM", "truecolor")
        for k, v in env_override.items():
            if isinstance(k, str) and isinstance(v, str):
                env[k] = v
        if terminal_id in self._terminals:
            raise ValueError(f"terminal already exists: {terminal_id}")

        pty = self._spawn(argv, cwd=cwd, env=env, rows=rows, cols=cols)
        record: dict[str, Any] = {
            "id": terminal_id,
            "sessionId": session_id,
            "pty": pty,
            "cols": cols,
            "rows": rows,
            "cwd": str(cwd),
            "shell": shell_cmd,
            "command": command,
            "args": args,
            "closed": False,
            "seq": 0,
        }
        record["task"] = asyncio.create_task(self._pump_terminal_output(record))
        self._terminals[terminal_id] = record
        return {
            "terminalId": terminal_id,
            "sessionId": session_id,
            "pid": self._pid(pty),
            "cwd": str(cwd),
            "cols": cols,
            "rows": rows,
            "shell": shell_cmd,
            "command": command,
            "args": args,
        }

    async def write(self, params: dict[str, Any]) -> dict[str, Any]:
        terminal_id = required_string(params, "terminalId")
        record = self._terminals.get(terminal_id)
        if record is None:
            raise KeyError(f"terminal not found: {terminal_id}")
        if record["closed"]:
            raise ValueError(f"terminal already closed: {terminal_id}")
        data_b64 = required_string(params, "dataBase64")
        try:
            data = base64.b64decode(data_b64)
        except Exception as exc:
            raise ValueError("dataBase64 must be valid base64") from exc
        await asyncio.to_thread(self._write_all, record["pty"], data)
        return {"terminalId": terminal_id, "bytesWritten": len(data)}

    async def resize(self, params: dict[str, Any]) -> dict[str, Any]:
        terminal_id = required_string(params, "terminalId")
        record = self._terminals.get(terminal_id)
        if record is None:
            return {"terminalId": terminal_id, "closed": True}
        cols = int(params.get("cols") or record["cols"])
        rows = int(params.get("rows") or record["rows"])
        cols = max(1, min(500, cols))
        rows = max(1, min(200, rows))
        try:
            self._setwinsize(record["pty"], rows, cols)
        except OSError:
            pass
        record["cols"] = cols
        record["rows"] = rows
        return {"terminalId": terminal_id, "cols": cols, "rows": rows}

    async def close(self, params: dict[str, Any]) -> dict[str, Any]:
        terminal_id = required_string(params, "terminalId")
        record = self._terminals.get(terminal_id)
        if record is None:
            return {"terminalId": terminal_id, "closed": True}
        await self._kill_terminal(record)
        return {"terminalId": terminal_id, "closed": True}

    async def list(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = params.get("sessionId")
        items: list[dict[str, Any]] = []
        for record in self._terminals.values():
            if session_id is not None and record["sessionId"] != session_id:
                continue
            items.append({
                "terminalId": record["id"],
                "sessionId": record["sessionId"],
                "pid": self._pid(record["pty"]) if not record["closed"] else None,
                "cols": record["cols"],
                "rows": record["rows"],
                "cwd": record["cwd"],
                "shell": record["shell"],
                "closed": record["closed"],
            })
        return {"terminals": items}

    async def _pump_terminal_output(self, record: dict[str, Any]) -> None:
        pty = record["pty"]
        loop = asyncio.get_running_loop()
        try:
            while True:
                try:
                    data = await loop.run_in_executor(None, self._read, pty)
                except OSError as exc:
                    if exc.errno in (errno.EIO,):
                        break
                    raise
                if not data:
                    break
                record["seq"] += 1
                await self._notify(
                    "terminal.output",
                    {
                        "terminalId": record["id"],
                        "sessionId": record["sessionId"],
                        "seq": record["seq"],
                        "dataBase64": base64.b64encode(data).decode("ascii"),
                    },
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._notify(
                "terminal.exited",
                {
                    "terminalId": record["id"],
                    "sessionId": record["sessionId"],
                    "exitCode": None,
                    "reason": f"pump_error: {exc.__class__.__name__}: {exc}",
                },
            )
            await self._cleanup_terminal(record)
            return
        exit_code = self._wait_exit_code(pty)
        await self._notify(
            "terminal.exited",
            {
                "terminalId": record["id"],
                "sessionId": record["sessionId"],
                "exitCode": exit_code,
                "reason": "exit",
            },
        )
        await self._cleanup_terminal(record)

    async def _kill_terminal(self, record: dict[str, Any]) -> None:
        if not record["closed"]:
            pty = record["pty"]
            self._terminate(pty)
            task = record.get("task")
            if isinstance(task, asyncio.Task):
                task.cancel()
            await self._cleanup_terminal(record)
        self._terminals.pop(record["id"], None)

    async def _cleanup_terminal(self, record: dict[str, Any]) -> None:
        if record["closed"]:
            return
        record["closed"] = True
        self._close(record["pty"])

    async def _notify(self, method: str, params: dict[str, Any]) -> None:
        if self.notify is not None:
            await self.notify(method, params)

    def _default_shell(self, requested: Any) -> str:
        if isinstance(requested, str) and requested.strip():
            return requested
        return os.environ.get("SHELL") or "/bin/bash"

    def _default_argv(self, shell_cmd: str) -> list[str]:
        return [shell_cmd, "-l"] if shell_cmd.endswith(("bash", "zsh", "sh")) else [shell_cmd]

    def _spawn(self, argv: list[str], *, cwd: Path, env: dict[str, str], rows: int, cols: int) -> Any:
        raise NotImplementedError

    def _read(self, pty: Any) -> bytes:
        raise NotImplementedError

    def _write_all(self, pty: Any, data: bytes) -> None:
        raise NotImplementedError

    def _setwinsize(self, pty: Any, rows: int, cols: int) -> None:
        raise NotImplementedError

    def _terminate(self, pty: Any) -> None:
        raise NotImplementedError

    def _close(self, pty: Any) -> None:
        raise NotImplementedError

    def _wait_exit_code(self, pty: Any) -> int | None:
        raise NotImplementedError

    def _pid(self, pty: Any) -> int | None:
        return getattr(pty, "pid", None)


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
