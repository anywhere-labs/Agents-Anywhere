from __future__ import annotations

import asyncio
import base64
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import threading
from typing import Any

import pytest

import connector.local.terminal as terminal_module
from connector.local.terminal import TerminalBackend, TerminalLimitError


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
    def __init__(self, notify=None, *, persistent_lease_ttl_seconds=1.0) -> None:
        super().__init__(
            notify=notify,
            idle_ttl_seconds=0.04,
            closed_ttl_seconds=60,
            reaper_poll_seconds=0.005,
            persistent_lease_ttl_seconds=persistent_lease_ttl_seconds,
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


class BlockingReadTerminalBackend(IdleTerminalBackend):
    def __init__(self, *, expected_reads: int = 1) -> None:
        super().__init__()
        self.expected_reads = expected_reads
        self.reads_started = 0
        self._reads_lock = threading.Lock()
        self.all_reads_started = threading.Event()

    def _read(self, pty: Any) -> bytes:
        with self._reads_lock:
            self.reads_started += 1
            if self.reads_started >= self.expected_reads:
                self.all_reads_started.set()
        pty["terminated"].wait()
        return b""


class NotifyGapTerminalBackend(IdleTerminalBackend):
    def __init__(self) -> None:
        super().__init__()
        self.read_count = 0
        self.writer_target = 1
        self.writers_started = 0
        self._state_lock = threading.Lock()
        self.second_read_started = threading.Event()
        self.all_writers_started = threading.Event()

    def _read(self, pty: Any) -> bytes:
        with self._state_lock:
            self.read_count += 1
            read_count = self.read_count
        if read_count == 1:
            return b"output"
        self.second_read_started.set()
        pty["terminated"].wait()
        return b""

    def _write_all(self, pty: Any, data: bytes) -> None:
        with self._state_lock:
            self.writers_started += 1
            if self.writers_started >= self.writer_target:
                self.all_writers_started.set()
        self.second_read_started.wait()
        with self._state_lock:
            self.writes.append(data)

    def _terminate(self, pty: Any) -> None:
        self.second_read_started.set()
        super()._terminate(pty)


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


def test_terminal_io_does_not_share_asyncio_default_executor(tmp_path):
    async def run() -> None:
        loop = asyncio.get_running_loop()
        loop.set_default_executor(ThreadPoolExecutor(max_workers=2))
        default_workers_started = [threading.Event(), threading.Event()]
        release_default_workers = threading.Event()

        def block_default_worker(started: threading.Event) -> None:
            started.set()
            release_default_workers.wait()

        blockers = [
            loop.run_in_executor(None, block_default_worker, started)
            for started in default_workers_started
        ]
        backend = BlockingReadTerminalBackend()
        try:
            await wait_until(
                lambda: all(started.is_set() for started in default_workers_started)
            )
            await backend.create(
                {
                    "terminalId": "trm_0",
                    "sessionId": "sess_1",
                    "root": str(tmp_path),
                    "cwd": str(tmp_path),
                    "shell": "/bin/zsh",
                }
            )
            await wait_until(backend.all_reads_started.is_set)

            await asyncio.wait_for(
                backend.write(
                    {
                        "terminalId": "trm_0",
                        "dataBase64": base64.b64encode(b"echo responsive\n").decode("ascii"),
                    }
                ),
                timeout=0.2,
            )

            assert backend.writes == [b"echo responsive\n"]
        finally:
            release_default_workers.set()
            await asyncio.gather(*blockers)
            await backend.aclose()

    asyncio.run(run())


def test_terminal_backend_shutdown_closes_every_terminal(tmp_path):
    async def run() -> None:
        backend = BlockingReadTerminalBackend(expected_reads=2)
        for index in range(2):
            await backend.create(
                {
                    "terminalId": f"trm_{index}",
                    "sessionId": "sess_1",
                    "root": str(tmp_path),
                    "cwd": str(tmp_path),
                    "shell": "/bin/zsh",
                }
            )
        await wait_until(backend.all_reads_started.is_set)
        records = list(backend._terminals.values())
        tasks = [
            record[key]
            for record in records
            for key in ("task", "reaperTask")
        ]
        executors = [
            record[key]
            for record in records
            for key in ("readExecutor", "writeExecutor")
        ]

        await backend.aclose()
        await backend.aclose()

        assert all(pty["terminated"].is_set() for pty in backend.spawned)
        assert all(task.done() for task in tasks)
        assert all(executor._shutdown for executor in executors)
        assert all(
            not thread.is_alive()
            for executor in executors
            for thread in executor._threads
        )
        assert (await backend.list({"sessionId": "sess_1"}))["terminals"] == []
        with pytest.raises(RuntimeError, match="terminal backend is closed"):
            await backend.create(
                {
                    "terminalId": "trm_after_close",
                    "sessionId": "sess_1",
                    "root": str(tmp_path),
                }
            )

    asyncio.run(run())


def test_terminal_read_resumes_while_writes_are_blocked_in_notify_gap(tmp_path):
    async def run() -> None:
        backend = NotifyGapTerminalBackend()
        notify_entered = asyncio.Event()
        release_notify = asyncio.Event()
        write_tasks: list[asyncio.Task[dict[str, Any]]] = []

        async def output(method: str, params: dict[str, Any]) -> None:
            assert method == "terminal.output"
            assert params["terminalId"] == "trm_gap"
            notify_entered.set()
            await release_notify.wait()

        try:
            await backend.create(
                {
                    "terminalId": "trm_gap",
                    "sessionId": "sess_1",
                    "root": str(tmp_path),
                    "cwd": str(tmp_path),
                    "shell": "/bin/zsh",
                    "persistent": True,
                },
                output=output,
            )
            await asyncio.wait_for(notify_entered.wait(), timeout=0.5)
            record = backend._terminals["trm_gap"]
            write_executor = record["writeExecutor"]
            backend.writer_target = write_executor._max_workers
            write_tasks = [
                asyncio.create_task(
                    backend.write(
                        {
                            "terminalId": "trm_gap",
                            "dataBase64": base64.b64encode(
                                f"write-{index}".encode()
                            ).decode("ascii"),
                        }
                    )
                )
                for index in range(backend.writer_target)
            ]
            await wait_until(backend.all_writers_started.is_set)

            release_notify.set()
            await asyncio.wait_for(asyncio.gather(*write_tasks), timeout=0.5)

            assert backend.second_read_started.is_set()
            assert len(backend.writes) == backend.writer_target
        finally:
            release_notify.set()
            backend.second_read_started.set()
            if write_tasks:
                await asyncio.gather(*write_tasks, return_exceptions=True)
            await backend.aclose()

    asyncio.run(run())


def test_terminal_backend_enforces_active_terminal_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(terminal_module, "TERMINAL_MAX_RECORDS", 2)

    async def run() -> None:
        backend = BlockingReadTerminalBackend(expected_reads=2)
        try:
            for index in range(2):
                await backend.create(
                    {
                        "terminalId": f"trm_{index}",
                        "sessionId": "sess_1",
                        "root": str(tmp_path),
                        "cwd": str(tmp_path),
                        "shell": "/bin/zsh",
                    }
                )
            await wait_until(backend.all_reads_started.is_set)

            with pytest.raises(TerminalLimitError, match="limit reached"):
                await backend.create(
                    {
                        "terminalId": "trm_over_limit",
                        "sessionId": "sess_1",
                        "root": str(tmp_path),
                    }
                )

            await backend.close({"terminalId": "trm_0"})
            await backend.create(
                {
                    "terminalId": "trm_replacement",
                    "sessionId": "sess_1",
                    "root": str(tmp_path),
                }
            )
            assert len(backend.spawned) == 3
        finally:
            await backend.aclose()

    asyncio.run(run())


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


def test_terminal_backend_does_not_reap_persistent_idle_terminal(tmp_path):
    async def run() -> None:
        events: list[tuple[str, dict[str, Any]]] = []

        async def notify(method: str, params: dict[str, Any]) -> None:
            events.append((method, params))

        backend = IdleTerminalBackend(notify=notify)
        created = await backend.create(
            {
                "terminalId": "trm_persistent",
                "sessionId": "sess_1",
                "root": str(tmp_path),
                "cwd": str(tmp_path),
                "shell": "/bin/zsh",
                "persistent": False,
            }
        )

        promoted = await backend.set_persistent(
            {"terminalId": "trm_persistent", "persistent": True}
        )

        await asyncio.sleep(0.12)

        assert created["persistent"] is False
        assert promoted["persistent"] is True
        assert not backend.spawned[0]["terminated"].is_set()
        assert events == []
        listing = await backend.list({"sessionId": "sess_1"})
        assert [item["terminalId"] for item in listing["terminals"]] == [
            "trm_persistent"
        ]
        assert listing["terminals"][0]["persistent"] is True

        await backend.close({"terminalId": "trm_persistent"})

        assert backend.spawned[0]["terminated"].is_set()
        assert (await backend.list({"sessionId": "sess_1"}))["terminals"] == []

    asyncio.run(run())


def test_terminal_backend_reaps_terminal_after_persistent_lease_expires(tmp_path):
    async def run() -> None:
        events: list[tuple[str, dict[str, Any]]] = []

        async def notify(method: str, params: dict[str, Any]) -> None:
            events.append((method, params))

        backend = IdleTerminalBackend(
            notify=notify,
            persistent_lease_ttl_seconds=0.1,
        )
        await backend.create(
            {
                "terminalId": "trm_lease",
                "sessionId": "sess_1",
                "root": str(tmp_path),
                "cwd": str(tmp_path),
                "shell": "/bin/zsh",
            }
        )
        await backend.set_persistent(
            {"terminalId": "trm_lease", "persistent": True}
        )

        await wait_until(lambda: backend.spawned[0]["terminated"].is_set())

        assert events[-1] == (
            "terminal.exited",
            {
                "terminalId": "trm_lease",
                "sessionId": "sess_1",
                "exitCode": None,
                "reason": "persistent_lease_expired",
            },
        )
        assert (await backend.list({"sessionId": "sess_1"}))["terminals"] == []

    asyncio.run(run())


def test_terminal_backend_refreshes_persistent_lease(tmp_path):
    async def run() -> None:
        events: list[tuple[str, dict[str, Any]]] = []

        async def notify(method: str, params: dict[str, Any]) -> None:
            events.append((method, params))

        backend = IdleTerminalBackend(
            notify=notify,
            persistent_lease_ttl_seconds=0.1,
        )
        await backend.create(
            {
                "terminalId": "trm_renewed_lease",
                "sessionId": "sess_1",
                "root": str(tmp_path),
                "cwd": str(tmp_path),
                "shell": "/bin/zsh",
            }
        )
        await backend.set_persistent(
            {"terminalId": "trm_renewed_lease", "persistent": True}
        )

        await asyncio.sleep(0.06)
        await backend.set_persistent(
            {"terminalId": "trm_renewed_lease", "persistent": True}
        )
        await asyncio.sleep(0.06)

        assert not backend.spawned[0]["terminated"].is_set()
        assert events == []

        await wait_until(lambda: backend.spawned[0]["terminated"].is_set())
        assert events[-1][1]["reason"] == "persistent_lease_expired"

    asyncio.run(run())
