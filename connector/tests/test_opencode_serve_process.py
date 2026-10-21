"""Unit tests for the opencode serve supervisor (binary resolution + child ownership)."""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from connector.runtimes.opencode import serve_process


def _script(body: str) -> list[str]:
    return [sys.executable, "-c", body]


# --------------------------------------------------------------------------- #
# find_executable_on_path
# --------------------------------------------------------------------------- #


def test_find_executable_windows_skips_extensionless_shim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    (tmp_path / "opencode").write_text("#!/bin/sh broken shim\n", encoding="utf-8")
    real = tmp_path / "opencode.cmd"
    real.write_text("@echo off\r\n", encoding="utf-8")
    found = serve_process.find_executable_on_path("opencode", str(tmp_path))
    assert found is not None
    assert Path(found).name == "opencode.cmd"


def test_find_executable_windows_exact_suffix_name(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    target = tmp_path / "opencode.exe"
    target.write_text("", encoding="utf-8")
    assert serve_process.find_executable_on_path("opencode.exe", str(tmp_path)) == str(target)


@pytest.mark.skipif(os.name == "nt", reason="posix executable-bit semantics")
def test_find_executable_posix_requires_executable_bit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "platform", "linux")
    candidate = tmp_path / "opencode"
    candidate.write_text("#!/bin/sh\n", encoding="utf-8")
    assert serve_process.find_executable_on_path("opencode", str(tmp_path)) is None
    os.chmod(candidate, 0o755)
    assert serve_process.find_executable_on_path("opencode", str(tmp_path)) == str(candidate)


def test_find_executable_missing_path_value() -> None:
    assert serve_process.find_executable_on_path("opencode", None) is None


# --------------------------------------------------------------------------- #
# check_version_output
# --------------------------------------------------------------------------- #


class _FakeCompleted:
    def __init__(self, returncode: int, stdout: str) -> None:
        self.returncode = returncode
        self.stdout = stdout


class _FakePopenProc:
    def __init__(self, result: _FakeCompleted) -> None:
        self.pid = 4321
        self.returncode = result.returncode
        self._stdout = result.stdout

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        return self._stdout, ""

    def kill(self) -> None:
        self.returncode = -9


class _TimeoutProc:
    """communicate() raises TimeoutExpired once, then drains."""

    def __init__(self) -> None:
        self.pid = 4321
        self.returncode: int | None = None
        self._calls = 0
        self.killed = False

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        self._calls += 1
        if self._calls == 1:
            raise subprocess.TimeoutExpired(["opencode", "--version"], 5.0)
        return "", ""

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


class _FakeSubprocess:
    SubprocessError = subprocess.SubprocessError
    TimeoutExpired = subprocess.TimeoutExpired
    PIPE = "pipe"
    DEVNULL = "devnull"
    CREATE_NO_WINDOW = 0x08000000

    def __init__(self, result: _FakeCompleted | None = None, exc: Exception | None = None) -> None:
        self._result = result
        self._exc = exc
        self.taskkill: list[Any] = []
        self.popen_kwargs: dict[str, Any] = {}

    def Popen(self, *args: Any, **kwargs: Any) -> Any:
        if self._exc is not None:
            raise self._exc
        self.popen_kwargs = kwargs
        if self._result is None:
            return _TimeoutProc()
        return _FakePopenProc(self._result)

    def run(self, *args: Any, **kwargs: Any) -> _FakeCompleted:
        # records taskkill tree-kill calls
        self.taskkill.append(args)
        return _FakeCompleted(0, "")


def _patch_subprocess(monkeypatch: pytest.MonkeyPatch, fake: _FakeSubprocess) -> None:
    monkeypatch.setattr(serve_process, "subprocess", fake)  # type: ignore[arg-type]


def test_check_version_output_accepts_semver_line(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_subprocess(monkeypatch, _FakeSubprocess(_FakeCompleted(0, "1.18.34\n")))
    assert serve_process.check_version_output("opencode", {}) is None


def test_version_probe_never_inherits_stdin_and_keeps_a_short_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A connector is spawned by the desktop app, where stdin is not a console.

    ``ServeProcess.spawn`` already passes ``DEVNULL``; the version probe did not,
    so it was the one spawn in this path that could block on an inherited handle.
    The budget is asserted too because it is a deliberate trade: two probes at
    15s each is what made the runtime look stuck for half a minute on a restart
    where the ``npx`` fallback would have been serving in 2.1s.
    """

    fake = _FakeSubprocess(_FakeCompleted(0, "1.18.34\n"))
    _patch_subprocess(monkeypatch, fake)
    assert serve_process.check_version_output("opencode", {}) is None
    assert fake.popen_kwargs["stdin"] == _FakeSubprocess.DEVNULL
    assert serve_process.VERSION_TIMEOUT_S <= 5.0


def test_check_version_output_rejects_garbage(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_subprocess(monkeypatch, _FakeSubprocess(_FakeCompleted(0, "opencode dev build\n")))
    assert serve_process.check_version_output("opencode", {}) == (
        "missing or invalid opencode version output"
    )


def test_check_version_output_rejects_nonzero_exit(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_subprocess(monkeypatch, _FakeSubprocess(_FakeCompleted(2, "1.0.0\n")))
    assert serve_process.check_version_output("opencode", {}) == "exited with code 2"


def test_check_version_output_rejects_oserror(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_subprocess(monkeypatch, _FakeSubprocess(exc=OSError("not a valid Win32 application")))
    assert serve_process.check_version_output("opencode", {}) == (
        "not a valid Win32 application"
    )


def test_check_version_output_timeout_kills_process_tree(monkeypatch: pytest.MonkeyPatch) -> None:
    """A grandchild holding the pipes must not extend the hang past the timeout."""
    fake = _FakeSubprocess(result=None)  # Popen -> _TimeoutProc
    _patch_subprocess(monkeypatch, fake)
    assert serve_process.check_version_output("opencode", {}) == (
        f"timed out after {int(serve_process.VERSION_TIMEOUT_S)}s"
    )
    if sys.platform == "win32":
        assert fake.taskkill
        assert fake.taskkill[0][0][0] == "taskkill"


def test_log_lock_failure_is_recognised_in_all_its_shapes() -> None:
    """The lock reaches us as a clean error or as a Bun crash, with no message.

    All three were observed on 1.18.34 while a TUI held opencode.log, and none of
    them can be fixed by retrying.
    """

    assert serve_process.is_serve_log_lock_failure(
        "Error: Unexpected error\n"
        r"Unknown: FileSystem.open (C:\Users\me\.local\share\opencode\log\opencode.log)"
    )
    assert serve_process.is_serve_log_lock_failure(
        "STATUS_STACK_BUFFER_OVERRUN (Bun 启动 fastfail)"
    )
    assert serve_process.is_serve_log_lock_failure(
        "oh no: Bun has crashed. This indicates a bug in Bun, not your code."
    )
    # A port collision is a different problem and must not be swallowed here.
    assert not serve_process.is_serve_log_lock_failure(
        "Error: listen EADDRINUSE 127.0.0.1:4096"
    )
    assert not serve_process.is_serve_log_lock_failure("")


# --------------------------------------------------------------------------- #
# data directory isolation and Basic auth
# --------------------------------------------------------------------------- #


def test_generated_server_password_is_unpredictable_and_url_safe() -> None:
    first = serve_process.generated_server_password()
    second = serve_process.generated_server_password()
    assert first and second and first != second
    assert len(first) >= 22
    assert all(char.isalnum() or char in "-_" for char in first)


def test_environment_credentials_follow_opencode_rules() -> None:
    # The username is fixed: serve ignores OPENCODE_SERVER_USERNAME, so a custom
    # value in the environment must not leak into the client's credentials.
    assert serve_process.environment_server_credentials({}) == ("opencode", None)
    assert serve_process.environment_server_credentials(
        {"OPENCODE_SERVER_PASSWORD": "  pw  ", "OPENCODE_SERVER_USERNAME": "licon"}
    ) == ("opencode", "pw")
    # A blank password is no password: the child would invent one the client
    # can never authenticate against.
    assert serve_process.environment_server_credentials(
        {"OPENCODE_SERVER_PASSWORD": "   "}
    ) == ("opencode", None)


def test_generated_server_credentials_pin_the_username_the_serve_checks() -> None:
    env = {"OPENCODE_SERVER_USERNAME": "licon"}
    user, password = serve_process.generated_server_credentials(env)
    assert user == "opencode"
    assert password and env["OPENCODE_SERVER_PASSWORD"] == password
    # Both sides must agree, so the child's env is pinned too rather than
    # inheriting a username serve would ignore.
    assert env["OPENCODE_SERVER_USERNAME"] == "opencode"


def test_registered_serve_credentials_let_discovery_authenticate() -> None:
    """Discovery probes without a runtime; it must reuse what auto-start made.

    An unauthenticated probe answers 401 on 2.x, which would report a healthy
    auto-started serve as unavailable.
    """

    # A port of its own: the registry is process-wide and other tests register
    # credentials for the default 4096 serve.
    url = "http://127.0.0.1:4909"
    assert serve_process.registered_serve_credentials(url) == (None, "")
    serve_process.register_serve_credentials(url + "/", "opencode", "secret")
    assert serve_process.registered_serve_credentials(url) == ("opencode", "secret")
    # A trailing slash in the config must resolve to the same entry.
    assert serve_process.registered_serve_credentials(url + "/") == ("opencode", "secret")
    # An unrelated serve is untouched.
    assert serve_process.registered_serve_credentials("http://127.0.0.1:4196") == (None, "")
    # Empty credentials are never registered.
    serve_process.register_serve_credentials("http://127.0.0.1:4197", "opencode", "")
    assert serve_process.registered_serve_credentials("http://127.0.0.1:4197") == (None, "")


def test_isolate_data_home_is_stable_per_tag_and_mirrors_credentials(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """The child needs its own data dir, or its boot dies on the log lock.

    opencode 2.x opens ``<data>/log/opencode.log`` and the session database
    exclusively, so a serve started while the user's interactive opencode runs
    dies within ~1s. The isolated directory must be *stable per port* (a new one
    per spawn would make session sync delete everything it synced last time) and
    must carry the user's provider logins.
    """

    connector_dir = tmp_path / "connector"
    monkeypatch.setenv("AGENT_CONNECTOR_DATA_DIR", str(connector_dir))
    user_data = tmp_path / "user-data" / "opencode"
    user_data.mkdir(parents=True)
    (user_data / "auth.json").write_text('{"anthropic":{}}', encoding="utf-8")
    (user_data / "account.json").write_text('{"email":"me@example.com"}', encoding="utf-8")

    env = {
        "USERPROFILE": str(tmp_path),
        "XDG_DATA_HOME": str(tmp_path / "user-data"),
    }
    first = serve_process.isolate_data_home(env, tag="4096")
    assert first == str(connector_dir / "opencode-serve" / "4096")
    assert env["XDG_DATA_HOME"] == first
    # opencode appends its own directory, and that is where it looks for
    # credentials — mirroring one level up would silently drop every login.
    opencode_home = Path(first) / "opencode"
    assert (opencode_home / "auth.json").read_text(encoding="utf-8") == '{"anthropic":{}}'
    assert (opencode_home / "account.json").exists()
    assert serve_process.opencode_log_path(env) == os.path.join(
        first, "opencode", "log", "opencode.log"
    )

    # Same tag, new environment: same directory, so sessions survive restarts.
    again = serve_process.isolate_data_home({"USERPROFILE": str(tmp_path)}, tag="4096")
    assert again == first
    # A different port gets its own directory (two serves must not share a db).
    other = serve_process.isolate_data_home({"USERPROFILE": str(tmp_path)}, tag="4196")
    assert other != first


def test_isolate_data_home_keeps_a_newer_mirrored_credential(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A credential opencode refreshed in the isolated dir must not be reverted."""

    connector_dir = tmp_path / "connector"
    monkeypatch.setenv("AGENT_CONNECTOR_DATA_DIR", str(connector_dir))
    user_data = tmp_path / "user-data" / "opencode"
    user_data.mkdir(parents=True)
    auth = user_data / "auth.json"
    auth.write_text("old", encoding="utf-8")
    isolated = connector_dir / "opencode-serve" / "4096" / "opencode"
    isolated.mkdir(parents=True)
    (isolated / "auth.json").write_text("newer", encoding="utf-8")
    os.utime(isolated / "auth.json", (os.path.getmtime(auth) + 60, os.path.getmtime(auth) + 60))

    serve_process.isolate_data_home({"XDG_DATA_HOME": str(tmp_path / "user-data")}, tag="4096")

    assert (isolated / "auth.json").read_text(encoding="utf-8") == "newer"


# --------------------------------------------------------------------------- #
# resolve_serve_command
# --------------------------------------------------------------------------- #


def _patch_resolution(
    monkeypatch: pytest.MonkeyPatch,
    found: dict[str, str | None],
    version_error: str | None = None,
) -> None:
    monkeypatch.setattr(
        serve_process,
        "find_executable_on_path",
        lambda name, path_value: found.get(name),
    )
    monkeypatch.setattr(
        serve_process,
        "check_version_output",
        lambda candidate, environment: version_error,
    )


def _npm_layout(tmp_path: Path) -> tuple[Path, Path]:
    """A ``%APPDATA%\\npm`` style install: a .cmd shim and the binary it runs."""

    package_dir = tmp_path / "node_modules" / "opencode-ai" / "bin"
    package_dir.mkdir(parents=True)
    native = package_dir / "opencode.exe"
    native.write_bytes(b"MZ")
    shim = tmp_path / "opencode.cmd"
    shim.write_text(
        "@ECHO off\r\nSETLOCAL\r\n"
        '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*\r\n',
        encoding="utf-8",
    )
    return shim, native


def test_forwarded_executable_resolves_the_npm_shim_target(tmp_path: Path) -> None:
    """npm's shim only execs the package binary -- read it instead of paying for it.

    Measured on a real install: ``opencode.cmd --version`` timed out after 15s
    (a cmd.exe plus a node boot per call) while the ``opencode.exe`` it wraps
    answered in 0.5s, so every connector start burned the timeout and fell back
    to the slower npx path.
    """

    shim, native = _npm_layout(tmp_path)

    assert serve_process.forwarded_executable(str(shim)) == str(native)
    # A real binary is not a launcher: nothing to forward to.
    assert serve_process.forwarded_executable(str(native)) is None
    # A shim that does not exist cannot be read.
    assert serve_process.forwarded_executable(str(tmp_path / "missing.cmd")) is None


def test_resolve_serve_command_probes_the_forwarded_binary_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    shim, native = _npm_layout(tmp_path)
    monkeypatch.setattr(
        serve_process,
        "find_executable_on_path",
        lambda name, path: str(shim) if name == "opencode" else None,
    )
    probed: list[str] = []
    monkeypatch.setattr(
        serve_process,
        "check_version_output",
        lambda candidate, environment: probed.append(candidate) and None,
    )

    assert serve_process.resolve_serve_command(4096, {"PATH": ""})[0] == str(native)
    assert probed == [str(native)], probed


def test_resolve_serve_command_falls_back_to_the_shim_when_the_binary_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unreadable/unrunnable target must not cost us the working shim."""

    shim, native = _npm_layout(tmp_path)
    monkeypatch.setattr(
        serve_process,
        "find_executable_on_path",
        lambda name, path: str(shim) if name == "opencode" else None,
    )
    monkeypatch.setattr(
        serve_process,
        "check_version_output",
        lambda candidate, environment: "boom" if candidate == str(native) else None,
    )

    assert serve_process.resolve_serve_command(4096, {"PATH": ""})[0] == str(shim)


def test_resolve_serve_command_prefers_verified_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_resolution(monkeypatch, {"opencode": r"C:\bin\opencode.cmd", "npx": r"C:\node\npx.cmd"})
    assert serve_process.resolve_serve_command(4096) == [
        r"C:\bin\opencode.cmd",
        "serve",
        *serve_process.SERVE_LOG_FLAGS,
        "--hostname",
        "127.0.0.1",
        "--port",
        "4096",
    ]


def test_resolve_serve_command_falls_back_when_version_check_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_resolution(
        monkeypatch,
        {"opencode": r"C:\bin\opencode.cmd", "npx": r"C:\node\npx.cmd"},
        version_error="exited with code 1",
    )
    assert serve_process.resolve_serve_command(5000) == [
        r"C:\node\npx.cmd",
        "opencode",
        "serve",
        *serve_process.SERVE_LOG_FLAGS,
        "--hostname",
        "127.0.0.1",
        "--port",
        "5000",
    ]


def test_resolve_serve_command_falls_back_to_npx(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_resolution(monkeypatch, {"npx": r"C:\node\npx.cmd"})
    assert serve_process.resolve_serve_command(5000) == [
        r"C:\node\npx.cmd",
        "opencode",
        "serve",
        *serve_process.SERVE_LOG_FLAGS,
        "--hostname",
        "127.0.0.1",
        "--port",
        "5000",
    ]


def test_resolve_serve_command_honours_hostname(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_resolution(monkeypatch, {"opencode": "/usr/local/bin/opencode"})
    assert serve_process.resolve_serve_command(4096, hostname="0.0.0.0")[-4:] == [
        "--hostname",
        "0.0.0.0",
        "--port",
        "4096",
    ]


def test_resolve_serve_command_always_forces_stderr_logs(monkeypatch: pytest.MonkeyPatch) -> None:
    """``--print-logs`` is load-bearing, not cosmetic.

    Asserted literally instead of via ``SERVE_LOG_FLAGS`` so that emptying the
    constant (which would silently reintroduce the boot failure described in
    ``resolve_serve_command``) fails here.
    """
    _patch_resolution(monkeypatch, {"opencode": "/usr/local/bin/opencode"})
    assert "--print-logs" in serve_process.resolve_serve_command(4096)


def test_resolve_serve_command_raises_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_resolution(monkeypatch, {})
    with pytest.raises(RuntimeError, match="not found"):
        serve_process.resolve_serve_command(4096)


# --------------------------------------------------------------------------- #
# is_port_in_use
# --------------------------------------------------------------------------- #


def test_is_port_in_use_markers() -> None:
    assert serve_process.is_port_in_use("Error: listen EADDRINUSE 127.0.0.1:4096") is True
    assert serve_process.is_port_in_use("address already in use") is True
    assert serve_process.is_port_in_use("server Already Listening on :4096") is True
    assert serve_process.is_port_in_use("connection refused") is False


# --------------------------------------------------------------------------- #
# ServeProcess with real children
# --------------------------------------------------------------------------- #


def _chatter_script(lines: int, marker: str, code: int) -> str:
    return (
        "import sys\n"
        f"for i in range({lines}):\n"
        "    print(f'line {i} ' + 'x' * 80)\n"
        f"print({marker!r})\n"
        f"sys.exit({code})\n"
    )


def test_serve_process_drains_pipe_and_reports_exit() -> None:
    """An undrained PIPE would fill and wedge the child before it can exit."""
    events: list[tuple[int | None, str]] = []

    async def on_exit(code: int | None, tail: str) -> None:
        events.append((code, tail))

    async def run() -> None:
        serve = serve_process.ServeProcess(on_exit=on_exit)
        await serve.spawn(_script(_chatter_script(3000, "BOOM-MARKER", 3)))
        deadline = asyncio.get_running_loop().time() + 30.0
        while not events and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.01)
        assert events
        code, tail = events[0]
        assert code == 3
        assert "BOOM-MARKER" in tail
        await serve.stop()

    asyncio.run(run())


def test_serve_process_stop_terminates_without_on_exit() -> None:
    events: list[tuple[int | None, str]] = []

    async def on_exit(code: int | None, tail: str) -> None:
        events.append((code, tail))

    async def run() -> None:
        serve = serve_process.ServeProcess(on_exit=on_exit)
        await serve.spawn(_script("import time; time.sleep(60)"))
        assert serve.process is not None
        await asyncio.wait_for(serve.stop(), timeout=15.0)
        assert serve.process is None
        assert events == []

    asyncio.run(run())


def test_wait_healthy_passes_and_child_survives() -> None:
    async def run() -> None:
        serve = serve_process.ServeProcess()
        await serve.spawn(_script("import time; time.sleep(60)"))
        calls = 0

        async def health() -> dict[str, bool]:
            nonlocal calls
            calls += 1
            if calls < 3:
                raise ValueError("down")
            return {"healthy": True}

        await serve.wait_healthy(health, ValueError, 5.0)
        assert calls == 3
        assert serve.process is not None and serve.process.returncode is None
        await serve.stop()

    asyncio.run(run())


def test_wait_healthy_early_exit_error_carries_tail(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serve_process, "HEALTH_POLL_INTERVAL_S", 0.01)

    async def run() -> None:
        serve = serve_process.ServeProcess()
        await serve.spawn(
            _script("print('listen EADDRINUSE 127.0.0.1:4096', flush=True); raise SystemExit(1)")
        )
        assert serve.process is not None

        async def down() -> dict[str, bool]:
            raise ValueError("connection refused")

        with pytest.raises(RuntimeError, match="exited early") as excinfo:
            await serve.wait_healthy(down, ValueError, 5.0)
        assert "EADDRINUSE" in str(excinfo.value)
        await serve.stop()

    asyncio.run(run())


def test_wait_healthy_times_out_when_never_reachable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(serve_process, "HEALTH_POLL_INTERVAL_S", 0.01)

    async def run() -> None:
        serve = serve_process.ServeProcess()
        await serve.spawn(_script("import time; time.sleep(60)"))

        async def down() -> dict[str, bool]:
            raise ValueError("connection refused")

        with pytest.raises(RuntimeError, match="did not become healthy"):
            await serve.wait_healthy(down, ValueError, 0.2)
        await serve.stop()

    asyncio.run(run())


def test_boot_grace_expired() -> None:
    async def run() -> None:
        serve = serve_process.ServeProcess()
        assert serve.boot_grace_expired(10.0) is False  # never spawned
        await serve.spawn(_script("import time; time.sleep(60)"))
        assert serve.boot_grace_expired(60.0) is False
        assert serve.boot_grace_expired(-1.0) is True
        await serve.stop()

    asyncio.run(run())
