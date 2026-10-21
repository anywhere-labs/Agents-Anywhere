from __future__ import annotations

import asyncio
import shutil
import sys
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import RuntimeConfig
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.ipc import (
    CodexIpcClient,
    CodexIpcService,
    FollowedThread,
    FollowerEvent,
    IpcBroadcast,
    IpcRequest,
    IpcResponse,
    IpcRouter,
)
from connector.runtimes.codex.runtime import CodexRuntime

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="Codex IPC uses Unix sockets"
)

THREAD = "01a12056-2619-7a80-be32-5d90a4721073"


class _TempHome:
    def __enter__(self) -> Path:
        self.path = Path(tempfile.mkdtemp(prefix="aa-ipcr-", dir="/tmp"))
        return self.path

    def __exit__(self, *exc: object) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


def _client(home: Path, path: Path, client_type: str) -> CodexIpcClient:
    return CodexIpcClient(codex_home=home, socket_path=path, allow_router=False, reconnect_delay=0.05, request_timeout_ms=3000, client_type=client_type)


async def _wait_for(predicate, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


class LateOwner:
    """A window that announces following first and claims ownership a bit later."""

    def __init__(self, client: CodexIpcClient) -> None:
        self.client = client
        self.owns = False
        self.discoveries = 0
        client.add_request_handler("thread-owner-discovery", self._can, self._handle)
        client.add_broadcast_handler("thread-stream-following-changed", self._on_following)

    async def _can(self, params: Any, request: IpcRequest) -> bool:
        self.discoveries += 1
        return self.owns and isinstance(params, Mapping) and params.get("conversationId") == THREAD

    async def _handle(self, request: IpcRequest) -> Any:
        return {"supportsUntrustedAppInput": True}

    async def _on_following(self, broadcast: IpcBroadcast) -> None:
        if broadcast.params.get("following") and broadcast.params.get("conversationId") == THREAD and self.owns:
            await self.client.broadcast(
                "thread-stream-state-changed",
                {"conversationId": THREAD, "hostId": "local", "change": {"type": "snapshot", "revision": 1, "conversationState": {"id": THREAD, "title": "late", "threadRuntimeStatus": {"type": "idle"}, "requests": [], "turnHistory": {"history": {"entitiesByKey": {}, "islands": []}}}}},
                target_client_ids=[broadcast.source_client_id],
            )


def test_service_retries_announced_thread_until_owner_registers() -> None:
    async def run() -> None:
        with _TempHome() as home:
            path = home / "ipc.sock"
            router = IpcRouter(discovery_timeout=0.3)
            await router.listen(path)
            window_client = _client(home, path, "desktop")
            window = LateOwner(window_client)
            client = _client(home, path, "agents-anywhere")
            for c in (window_client, client):
                await c.start()
                await c.wait_until_initialized(timeout=2)
            events: list[FollowerEvent] = []

            async def on_event(event: FollowerEvent) -> None:
                events.append(event)

            service = CodexIpcService(client=client, codex_home=home, on_event=on_event, scan_interval=60, retry_interval=60, announce_retry_delay=0.2)
            await service.start()
            await _wait_for(lambda: service.scan_count >= 1)

            # The window opens the thread: it announces following before its resume finished.
            await window_client.broadcast("thread-stream-following-changed", {"conversationId": THREAD, "hostId": "local", "following": True})
            await _wait_for(lambda: service.follower.get(THREAD) is not None and service.follower.get(THREAD).status == "no_owner")
            window.owns = True  # resume completed, ownership registered
            await _wait_for(lambda: service.follower.get(THREAD) is not None and service.follower.get(THREAD).has_state, timeout=5)
            assert window.discoveries >= 2
            assert service.follower.get(THREAD).state["title"] == "late"

            await service.stop()
            await client.stop()
            await window_client.stop()
            await router.close()

    asyncio.run(run())


def test_service_held_threads_retry_sooner() -> None:
    import fcntl
    import os

    with _TempHome() as home:
        (home / "thread-writer-locks").mkdir()
        lock_path = home / "thread-writer-locks" / f"{THREAD}.lock"
        lock_path.touch()
        # A stale lock file (holder exited) does not count as held.
        (home / "thread-writer-locks" / "01a12048-c50d-7cb3-9de3-f0a61be677b8.lock").touch()
        fd = os.open(lock_path, os.O_RDWR)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)

        class _Client:
            client_id = "x"

            def add_broadcast_handler(self, *a, **k):
                return lambda: None

            def add_any_broadcast_handler(self, *a, **k):
                return lambda: None

        async def on_event(event: FollowerEvent) -> None:
            pass

        service = CodexIpcService(client=_Client(), codex_home=home, on_event=on_event)  # type: ignore[arg-type]
        try:
            assert service.thread_is_held(THREAD)
            assert not service.thread_is_held("01a12048-c50d-7cb3-9de3-f0a61be677b8")
            assert not service.thread_is_held("01a1207d-92df-7c00-8410-5df765e88cb9")
        finally:
            os.close(fd)
        assert not service.thread_is_held(THREAD)


# -- runtime: attach before writing ---------------------------------------------


class _Host(RuntimeHostClient):
    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def session_state_update(self, *a, **k):
        pass

    async def session_capabilities_update(self, c):
        pass


class _Follower:
    def __init__(self) -> None:
        self.thread: FollowedThread | None = None
        self.follow_calls: list[tuple[str, int | None]] = []

    def get(self, thread_id: str) -> FollowedThread | None:
        return self.thread if self.thread is not None and thread_id == self.thread.thread_id else None

    async def follow(self, thread_id: str, *, discovery_timeout_ms: int | None = None) -> FollowedThread:
        self.follow_calls.append((thread_id, discovery_timeout_ms))
        self.thread = FollowedThread(thread_id=thread_id, status="following", owner_client_id="owner-1", revision=1, state={"cwd": "/w", "currentPermissions": {}})
        return self.thread


class _Service:
    def __init__(self, follower: _Follower, held: bool) -> None:
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


def test_runtime_probes_owner_before_sdk_path_when_thread_is_held() -> None:
    async def run() -> None:
        follower = _Follower()
        client = _Client()
        runtime = CodexRuntime(
            config=RuntimeConfig(runtime="codex", revision=3, values={"codexHome": "/x"}),
            host=_Host(),
            client=None,
            ipc=client,  # type: ignore[arg-type]
            ipc_service=_Service(follower, held=True),  # type: ignore[arg-type]
        )
        result = await runtime.start_turn("sess_1", THREAD, "hi")
        assert result.ok and result.result["transport"] == "ipc"
        assert follower.follow_calls == [(THREAD, 3000)]
        assert client.calls == ["thread-follower-start-turn"]

        # Not held anywhere: no probe, straight to the (unavailable) SDK path.
        follower2 = _Follower()
        runtime2 = CodexRuntime(
            config=RuntimeConfig(runtime="codex", revision=3, values={"codexHome": "/x"}),
            host=_Host(),
            client=None,
            ipc=_Client(),  # type: ignore[arg-type]
            ipc_service=_Service(follower2, held=False),  # type: ignore[arg-type]
        )
        with pytest.raises(Exception):  # noqa: B017 - SDK path is unavailable without a client
            await runtime2.start_turn("sess_2", THREAD, "hi")
        assert follower2.follow_calls == []

    asyncio.run(run())

