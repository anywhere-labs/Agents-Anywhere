"""Deep-link handoff: let the running Codex desktop app own a locked thread."""

from __future__ import annotations

import asyncio
import sys

import pytest

from connector.runtime_protocol import RuntimeConfig
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.ipc import FollowedThread, IpcResponse
from connector.runtimes.codex.ipc import deeplink as ipc_deeplink
from connector.runtimes.codex.runtime import CodexRuntime

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="Codex IPC uses Unix sockets"
)

THREAD = "01a12056-2619-7a80-be32-5d90a4721073"


# -- pure helpers ----------------------------------------------------------------


def test_thread_deeplink_accepts_only_thread_ids() -> None:
    assert ipc_deeplink.thread_deeplink(THREAD.upper()) == f"codex://threads/{THREAD}"
    for bad in ("", "thread_1", "../x", f"{THREAD}?ephemeral", "01a12056-2619-7a80"):
        with pytest.raises(ValueError):
            ipc_deeplink.thread_deeplink(bad)


def test_opener_command_per_platform() -> None:
    url = f"codex://threads/{THREAD}"
    assert ipc_deeplink.opener_command(url, "darwin") == ("open", "-g", url)
    assert ipc_deeplink.opener_command(url, "linux") == ("xdg-open", url)
    assert ipc_deeplink.opener_command(url, "win32") is None
    assert ipc_deeplink.deeplink_supported("darwin")
    assert not ipc_deeplink.deeplink_supported("freebsd")


def test_desktop_process_listed_matches_main_process_only() -> None:
    markers = ipc_deeplink.DESKTOP_PROCESS_MARKERS["darwin"]
    listing = (
        "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer)\n"
        "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
    )
    assert not ipc_deeplink.desktop_process_listed(listing, markers)
    assert ipc_deeplink.desktop_process_listed(
        listing + "\n/Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n", markers
    )


# -- runtime fakes ---------------------------------------------------------------


class _Host(RuntimeHostClient):
    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def session_state_update(self, *a, **k):
        pass

    async def session_capabilities_update(self, c):
        pass


class _Follower:
    """Replays scripted statuses: the owner only appears after the deeplink."""

    def __init__(self, statuses: list[str]) -> None:
        self.statuses = statuses
        self.thread: FollowedThread | None = None
        self.follow_calls: list[int | None] = []

    def get(self, thread_id: str) -> FollowedThread | None:
        return self.thread if self.thread is not None and thread_id == self.thread.thread_id else None

    async def follow(self, thread_id: str, *, discovery_timeout_ms: int | None = None) -> FollowedThread:
        self.follow_calls.append(discovery_timeout_ms)
        status = self.statuses.pop(0) if self.statuses else "following"
        if status == "following":
            self.thread = FollowedThread(thread_id=thread_id, status="following", owner_client_id="desktop-1", revision=1, state={"cwd": "/w", "currentPermissions": {}})
        else:
            self.thread = FollowedThread(thread_id=thread_id, status=status, error="no-client-found")  # type: ignore[arg-type]
        return self.thread


class _Service:
    def __init__(self, follower: _Follower, held: bool = True) -> None:
        self.follower = follower
        self.held = held

    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    def thread_is_held(self, thread_id: str) -> bool:
        return self.held


class _Client:
    client_id = "self"

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def request(self, method, params, *, target_client_id=None, host_id=None, timeout_ms=None):
        self.calls.append(method)
        return IpcResponse(request_id="r", result_type="success", method=method, handled_by_client_id=target_client_id, result={"result": {"turn": {"id": "t"}}})

    async def start(self) -> None: ...

    async def stop(self) -> None: ...


class _Desktop:
    """Stands in for the OS: records deeplinks and reports whether the app runs."""

    def __init__(self, running: bool | None = True, opens: bool = True) -> None:
        self.running = running
        self.opens = opens
        self.opened: list[str] = []

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def open_deeplink(url: str, *, timeout: float = 5.0) -> bool:
            self.opened.append(url)
            return self.opens

        async def desktop_app_running(*, timeout: float = 5.0) -> bool | None:
            return self.running

        monkeypatch.setattr(ipc_deeplink, "open_deeplink", open_deeplink)
        monkeypatch.setattr(ipc_deeplink, "desktop_app_running", desktop_app_running)
        monkeypatch.setattr(ipc_deeplink, "deeplink_supported", lambda platform=None: True)


def _runtime(follower: _Follower, client: _Client, *, held: bool = True, **kwargs) -> CodexRuntime:
    return CodexRuntime(
        config=RuntimeConfig(runtime="codex", revision=3, values={"codexHome": "/x"}),
        host=_Host(),
        client=None,
        ipc=client,  # type: ignore[arg-type]
        ipc_service=_Service(follower, held=held),  # type: ignore[arg-type]
        **kwargs,
    )


# -- automatic handoff before writing ----------------------------------------------


def test_start_turn_hands_locked_ownerless_thread_to_desktop(monkeypatch: pytest.MonkeyPatch) -> None:
    desktop = _Desktop()
    desktop.install(monkeypatch)

    async def run() -> None:
        follower = _Follower(["unreachable", "following"])
        client = _Client()
        runtime = _runtime(follower, client)
        result = await runtime.start_turn("sess_1", THREAD, "hi")
        assert result.ok and result.result["transport"] == "ipc"
        assert desktop.opened == [f"codex://threads/{THREAD}"]
        assert follower.follow_calls == [3000, 5000]
        assert client.calls == ["thread-follower-start-turn"]

    asyncio.run(run())


@pytest.mark.parametrize("running", [False, None])
def test_no_handoff_when_desktop_app_is_absent_or_unknown(monkeypatch: pytest.MonkeyPatch, running: bool | None) -> None:
    desktop = _Desktop(running=running)
    desktop.install(monkeypatch)

    async def run() -> None:
        follower = _Follower(["no_owner", "following"])
        runtime = _runtime(follower, _Client())
        with pytest.raises(Exception):  # noqa: B017 - SDK path is unavailable without a client
            await runtime.start_turn("sess_1", THREAD, "hi")
        assert desktop.opened == []
        assert follower.follow_calls == [3000]

    asyncio.run(run())


def test_handoff_can_be_disabled_and_skips_unlocked_threads(monkeypatch: pytest.MonkeyPatch) -> None:
    desktop = _Desktop()
    desktop.install(monkeypatch)

    async def run() -> None:
        follower = _Follower(["no_owner", "following"])
        runtime = _runtime(follower, _Client(), ipc_deeplink_handoff=False)
        with pytest.raises(Exception):  # noqa: B017
            await runtime.start_turn("sess_1", THREAD, "hi")
        assert desktop.opened == [] and follower.follow_calls == [3000]

        follower2 = _Follower(["no_owner", "following"])
        runtime2 = _runtime(follower2, _Client(), held=False)
        with pytest.raises(Exception):  # noqa: B017
            await runtime2.start_turn("sess_2", THREAD, "hi")
        assert desktop.opened == [] and follower2.follow_calls == []

    asyncio.run(run())


def test_handoff_falls_back_to_sdk_when_owner_never_appears(monkeypatch: pytest.MonkeyPatch) -> None:
    desktop = _Desktop()
    desktop.install(monkeypatch)

    async def run() -> None:
        follower = _Follower(["unreachable", "unreachable"])
        runtime = _runtime(follower, _Client())
        with pytest.raises(Exception):  # noqa: B017
            await runtime.start_turn("sess_1", THREAD, "hi")
        assert len(desktop.opened) == 1
        assert follower.follow_calls == [3000, 5000]

    asyncio.run(run())


# -- explicit command --------------------------------------------------------------


def test_catalog_offers_open_in_codex_app_only_with_ipc(monkeypatch: pytest.MonkeyPatch) -> None:
    _Desktop().install(monkeypatch)

    async def run() -> None:
        runtime = _runtime(_Follower([]), _Client())
        catalog = {c.id: c for c in await runtime.list_commands("sess_1", THREAD)}
        assert set(catalog) == {"compact", "open-in-codex-app", "kill-chatgpt"}
        command = catalog["open-in-codex-app"]
        assert command.enabled and "running" in command.metadata["ui"]["allowedStatuses"]
        assert set(command.aliases) == {"open-in-codex", "codex-app"}
        # compact is disabled because there is no SDK client in this fixture
        assert not catalog["compact"].enabled
        assert [c.id for c in await runtime.list_commands("sess_1", THREAD, "codex app")] == ["open-in-codex-app"]
        unloaded = {c.id: c for c in await runtime.list_commands("sess_1", None)}
        assert unloaded["open-in-codex-app"].disabled_reason == "session_unloaded"

        plain = CodexRuntime(config=RuntimeConfig(runtime="codex", revision=3, values={"codexHome": "/x"}), host=_Host(), client=None)
        assert [c.id for c in await plain.list_commands("sess_1", THREAD)] == ["compact", "kill-chatgpt"]

    asyncio.run(run())


def test_open_in_codex_app_command_opens_deeplink_and_follows(monkeypatch: pytest.MonkeyPatch) -> None:
    desktop = _Desktop()
    desktop.install(monkeypatch)

    async def run() -> None:
        follower = _Follower(["following"])
        runtime = _runtime(follower, _Client())
        result = await runtime.execute_command("sess_1", "/open-in-codex-app", THREAD, "/open-in-codex-app")
        assert result.ok and result.result == {
            "deeplink": f"codex://threads/{THREAD}",
            "attached": True,
            "ownerClientId": "desktop-1",
            "executionState": "completed",
        }
        assert desktop.opened == [f"codex://threads/{THREAD}"]
        assert follower.follow_calls == [5000]

        # aliases resolve, arguments are rejected
        alias = await runtime.execute_command("sess_1", "codex-app", THREAD)
        assert alias.ok and alias.command == "open-in-codex-app"
        with_args = await runtime.execute_command("sess_1", "open-in-codex-app", THREAD, "/open-in-codex-app now")
        assert not with_args.ok and with_args.code == "invalid_command"

        # no thread id yet
        unloaded = await runtime.execute_command("sess_9", "open-in-codex-app", None)
        assert not unloaded.ok and unloaded.code == "command_unavailable"
        assert unloaded.message == "session_unloaded"

        # other commands still go through the native controller
        other = await runtime.execute_command("sess_1", "compact", THREAD)
        assert not other.ok and other.code == "command_unavailable"

    asyncio.run(run())


def test_open_in_codex_app_reports_missing_app(monkeypatch: pytest.MonkeyPatch) -> None:
    desktop = _Desktop(running=False)
    desktop.install(monkeypatch)

    async def run() -> None:
        runtime = _runtime(_Follower([]), _Client())
        result = await runtime.execute_command("sess_1", "open-in-codex-app", THREAD)
        assert not result.ok and result.code == "command_unavailable"
        assert result.message == "codex_app_not_running"
        assert desktop.opened == []

    asyncio.run(run())


def test_open_in_codex_app_reports_opener_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    desktop = _Desktop(opens=False)
    desktop.install(monkeypatch)

    async def run() -> None:
        runtime = _runtime(_Follower(["unreachable"]), _Client())
        result = await runtime.execute_command("sess_1", "open-in-codex-app", THREAD)
        assert not result.ok and result.code == "command_error"
        assert desktop.opened == [f"codex://threads/{THREAD}"] * 2

    asyncio.run(run())


# -- kill-chatgpt ------------------------------------------------------------------


def test_desktop_pids_from_listing_requires_pid_and_main_process() -> None:
    from connector.runtimes.codex.ipc import desktop_app

    markers = desktop_app.DESKTOP_PROCESS_MARKERS["darwin"]
    listing = (
        " 3553 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer)\n"
        "90583 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n"
        "  123 /Applications/Codex.app/Contents/MacOS/Codex\n"
    )
    assert desktop_app.desktop_pids_from_listing(listing, markers) == (90583, 123)
    assert desktop_app.desktop_pids_from_listing("", markers) == ()


def test_quit_desktop_app_terminates_then_kills(monkeypatch: pytest.MonkeyPatch) -> None:
    import os
    import signal
    import subprocess

    from connector.runtimes.codex.ipc import desktop_app

    # Two stand-in "desktop" processes: one exits on SIGTERM, one ignores it.
    polite = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    stubborn = subprocess.Popen(
        [sys.executable, "-c", "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"]
    )
    try:
        import time

        time.sleep(0.5)  # let the stubborn child install its handler

        async def fake_pids(*, timeout: float = 5.0):
            return (polite.pid, stubborn.pid)

        monkeypatch.setattr(desktop_app, "desktop_app_pids", fake_pids)
        result = asyncio.run(desktop_app.quit_desktop_app(grace_period=1.0))
        assert result.ok and result.found
        assert result.terminated == (polite.pid,)
        assert result.killed == (stubborn.pid,)
        # quit_desktop_app may have reaped the children already; either way they are gone.
        for proc in (polite, stubborn):
            try:
                proc.wait(timeout=5)
            except ChildProcessError:
                pass
        assert not desktop_app._alive(polite.pid) and not desktop_app._alive(stubborn.pid)
    finally:
        for proc in (polite, stubborn):
            if proc.poll() is None:
                os.kill(proc.pid, signal.SIGKILL)
                proc.wait()


def test_kill_chatgpt_command_stops_app_and_unfollows(monkeypatch: pytest.MonkeyPatch) -> None:
    from connector.runtimes.codex.ipc import desktop_app

    calls: list[str] = []

    async def quit_desktop_app(*, grace_period: float = 5.0, timeout: float = 5.0):
        calls.append("quit")
        return desktop_app.DesktopAppShutdown(terminated=(90583,), details={"found": True})

    monkeypatch.setattr(desktop_app, "quit_desktop_app", quit_desktop_app)
    monkeypatch.setattr(desktop_app, "supported", lambda platform=None: True)

    class _UnfollowingFollower(_Follower):
        def __init__(self) -> None:
            super().__init__([])
            self.unfollowed: list[str] = []

        async def unfollow(self, thread_id: str) -> None:
            self.unfollowed.append(thread_id)
            self.thread = None

    async def run() -> None:
        follower = _UnfollowingFollower()
        follower.thread = FollowedThread(thread_id=THREAD, status="following", owner_client_id="desktop-1", revision=1, state={"cwd": "/w"})
        runtime = _runtime(follower, _Client())
        catalog = {c.id: c for c in await runtime.list_commands("sess_1", THREAD)}
        assert catalog["kill-chatgpt"].enabled
        assert set(catalog["kill-chatgpt"].aliases) == {"kill-codex-app", "quit-chatgpt"}
        result = await runtime.execute_command("sess_1", "/kill-chatgpt", THREAD, "/kill-chatgpt")
        assert result.ok and result.result == {
            "terminated": [90583],
            "killed": [],
            "survivors": [],
            "executionState": "completed",
        }
        assert calls == ["quit"] and follower.unfollowed == [THREAD]
        assert runtime._ipc_attached_thread("sess_1", THREAD) is None

        with_args = await runtime.execute_command("sess_1", "quit-chatgpt", THREAD, "/quit-chatgpt now")
        assert not with_args.ok and with_args.code == "invalid_command"

        # Works without IPC too.
        plain = CodexRuntime(config=RuntimeConfig(runtime="codex", revision=3, values={"codexHome": "/x"}), host=_Host(), client=None)
        again = await plain.execute_command("sess_1", "kill-chatgpt", THREAD)
        assert again.ok and calls == ["quit", "quit"]

    asyncio.run(run())


def test_kill_chatgpt_reports_missing_app_and_survivors(monkeypatch: pytest.MonkeyPatch) -> None:
    from connector.runtimes.codex.ipc import desktop_app

    outcomes = [
        desktop_app.DesktopAppShutdown(details={"found": False}),
        desktop_app.DesktopAppShutdown(terminated=(1,), survivors=(2,), details={"found": True}),
    ]

    async def quit_desktop_app(*, grace_period: float = 5.0, timeout: float = 5.0):
        return outcomes.pop(0)

    monkeypatch.setattr(desktop_app, "quit_desktop_app", quit_desktop_app)
    monkeypatch.setattr(desktop_app, "supported", lambda platform=None: True)

    async def run() -> None:
        runtime = _runtime(_Follower([]), _Client())
        missing = await runtime.execute_command("sess_1", "kill-chatgpt", THREAD)
        assert not missing.ok and missing.code == "command_unavailable"
        assert missing.message == "codex_app_not_running"
        partial = await runtime.execute_command("sess_1", "kill-chatgpt", THREAD)
        assert not partial.ok and partial.code == "command_error"
        assert partial.result["survivors"] == [2]

    asyncio.run(run())


def test_service_scans_once_without_periodic_rescan() -> None:
    from connector.runtimes.codex.ipc import CodexIpcService

    class _Client:
        client_id = "x"
        initialized = True

        def add_broadcast_handler(self, *a, **k):
            return lambda: None

        def add_any_broadcast_handler(self, *a, **k):
            return lambda: None

        async def wait_until_initialized(self, timeout=None):
            return None

    async def run() -> None:
        import tempfile
        from pathlib import Path

        home = Path(tempfile.mkdtemp(prefix="aa-ipcs-", dir="/tmp"))
        scans: list[int] = []

        async def on_event(event) -> None:
            pass

        class _CountingService(CodexIpcService):
            async def scan_once(self) -> None:
                scans.append(1)
                self._scan_count += 1

        service = _CountingService(client=_Client(), codex_home=home, on_event=on_event)  # type: ignore[arg-type]
        assert service.scan_interval is None
        await service.start()
        for _ in range(50):
            if service.scan_count >= 1:
                break
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.3)
        assert service.scan_count == 1  # no timer-driven rescans
        service.request_scan()
        for _ in range(50):
            if service.scan_count >= 2:
                break
            await asyncio.sleep(0.01)
        assert service.scan_count == 2  # events still trigger a scan
        await service.stop()

    asyncio.run(run())
