from __future__ import annotations

import asyncio
import base64
from pathlib import Path
import threading
from typing import Any

from connector.local.terminal import TerminalBackend


class FakeTerminalBackend(TerminalBackend):
    def __init__(self) -> None:
        super().__init__(notify=None)
        self.spawned: list[dict[str, Any]] = []

    def _spawn(self, argv: list[str], *, cwd: Path, env: dict[str, str], rows: int, cols: int) -> Any:
        self.spawned.append({"argv": argv, "cwd": cwd, "env": env, "rows": rows, "cols": cols})
        return type("FakePty", (), {"pid": 123})()

    def _read(self, pty: Any) -> bytes:
        return b""

    def _write_all(self, pty: Any, data: bytes) -> None:
        pass

    def _setwinsize(self, pty: Any, rows: int, cols: int) -> None:
        pass

    def _terminate(self, pty: Any) -> None:
        pass

    def _close(self, pty: Any) -> None:
        pass

    def _wait_exit_code(self, pty: Any) -> int | None:
        return 0


class IdleTerminalBackend(TerminalBackend):
    def __init__(self, notify=None) -> None:
        super().__init__(
            notify=notify,
            idle_ttl_seconds=0.04,
            closed_ttl_seconds=60,
            reaper_poll_seconds=0.005,
        )
        self.spawned: list[dict[str, Any]] = []
        self.writes: list[bytes] = []

    def _spawn(self, argv: list[str], *, cwd: Path, env: dict[str, str], rows: int, cols: int) -> Any:
        pty = {"pid": 456, "terminated": threading.Event()}
        self.spawned.append(pty)
        return pty

    def _read(self, pty: Any) -> bytes:
        pty["terminated"].wait(timeout=1)
        return b""

    def _write_all(self, pty: Any, data: bytes) -> None:
        self.writes.append(data)

    def _setwinsize(self, pty: Any, rows: int, cols: int) -> None:
        pass

    def _terminate(self, pty: Any) -> None:
        pty["terminated"].set()

    def _close(self, pty: Any) -> None:
        pty["terminated"].set()

    def _wait_exit_code(self, pty: Any) -> int | None:
        return None


async def wait_until(predicate, *, timeout: float = 0.5) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise AssertionError("condition was not met before timeout")
        await asyncio.sleep(0.01)


def test_terminal_backend_spawns_structured_command_args(tmp_path):
    backend = FakeTerminalBackend()

    result = asyncio.run(
        backend.create(
            {
                "terminalId": "trm_1",
                "sessionId": "sess_1",
                "root": str(tmp_path),
                "cwd": str(tmp_path),
                "command": "claude",
                "args": ["--resume", "uuid-1"],
                "cols": 120,
                "rows": 36,
            }
        )
    )

    assert backend.spawned[0]["argv"] == ["claude", "--resume", "uuid-1"]
    assert backend.spawned[0]["cwd"] == tmp_path
    assert result["pid"] == 123
    asyncio.run(backend.close({"terminalId": "trm_1"}))


def test_terminal_backend_keeps_shell_default_for_plain_terminal(tmp_path):
    backend = FakeTerminalBackend()

    asyncio.run(
        backend.create(
            {
                "terminalId": "trm_1",
                "sessionId": "sess_1",
                "root": str(tmp_path),
                "cwd": str(tmp_path),
                "shell": "/bin/zsh",
            }
        )
    )

    assert backend.spawned[0]["argv"] == ["/bin/zsh", "-l"]
    asyncio.run(backend.close({"terminalId": "trm_1"}))


def test_terminal_backend_reaps_idle_running_terminal(tmp_path):
    async def run() -> None:
        events: list[tuple[str, dict[str, Any]]] = []

        async def notify(method: str, params: dict[str, Any]) -> None:
            events.append((method, params))

        backend = IdleTerminalBackend(notify=notify)
        await backend.create(
            {
                "terminalId": "trm_idle",
                "sessionId": "sess_1",
                "root": str(tmp_path),
                "cwd": str(tmp_path),
                "shell": "/bin/zsh",
            }
        )

        await wait_until(lambda: bool(events))

        assert backend.spawned[0]["terminated"].is_set()
        assert events == [
            (
                "terminal.exited",
                {
                    "terminalId": "trm_idle",
                    "sessionId": "sess_1",
                    "exitCode": None,
                    "reason": "idle_timeout",
                },
            )
        ]
        listing = await backend.list({"sessionId": "sess_1"})
        assert listing["terminals"] == []

    asyncio.run(run())


def test_terminal_backend_terminal_activity_refreshes_idle_deadline(tmp_path):
    async def run() -> None:
        events: list[tuple[str, dict[str, Any]]] = []

        async def notify(method: str, params: dict[str, Any]) -> None:
            events.append((method, params))

        backend = IdleTerminalBackend(notify=notify)
        await backend.create(
            {
                "terminalId": "trm_active",
                "sessionId": "sess_1",
                "root": str(tmp_path),
                "cwd": str(tmp_path),
                "shell": "/bin/zsh",
            }
        )
        await asyncio.sleep(0.025)
        await backend.write(
            {
                "terminalId": "trm_active",
                "dataBase64": base64.b64encode(b"pwd\n").decode("ascii"),
            }
        )
        await asyncio.sleep(0.025)

        listing = await backend.list({"sessionId": "sess_1"})
        assert [item["terminalId"] for item in listing["terminals"]] == ["trm_active"]

        await wait_until(lambda: bool(events))

        assert backend.writes == [b"pwd\n"]
        assert events[-1] == (
            "terminal.exited",
            {
                "terminalId": "trm_active",
                "sessionId": "sess_1",
                "exitCode": None,
                "reason": "idle_timeout",
            },
        )
        listing = await backend.list({"sessionId": "sess_1"})
        assert listing["terminals"] == []

    asyncio.run(run())
