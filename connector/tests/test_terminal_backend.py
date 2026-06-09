from __future__ import annotations

import asyncio
from pathlib import Path
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
