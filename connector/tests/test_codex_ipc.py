from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import RuntimeConfig
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.ipc import (
    CodexIpcClient,
    FrameDecoder,
    IpcBroadcast,
    IpcFrameError,
    IpcRequest,
    IpcRouter,
    accepts_version,
    encode_frame,
    version_for,
)
from connector.runtimes.codex.runtime import CodexRuntime

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="Codex IPC uses Unix sockets"
)


# -- framing -------------------------------------------------------------------


def test_frame_roundtrip_and_partial_feed() -> None:
    first = encode_frame({"type": "broadcast", "method": "a", "params": {"x": "你好"}})
    second = encode_frame({"type": "response", "requestId": "1"})
    decoder = FrameDecoder()
    stream = first + second
    assert decoder.feed(stream[:3]) == []
    assert decoder.feed(stream[3 : len(first) + 2]) == [
        {"type": "broadcast", "method": "a", "params": {"x": "你好"}}
    ]
    assert decoder.feed(stream[len(first) + 2 :]) == [{"type": "response", "requestId": "1"}]


def test_frame_rejects_invalid_length_and_payload() -> None:
    with pytest.raises(IpcFrameError):
        FrameDecoder().feed(b"\x00\x00\x00\x00")
    with pytest.raises(IpcFrameError):
        FrameDecoder().feed(b"\xff\xff\xff\xff")
    with pytest.raises(IpcFrameError):
        FrameDecoder().feed(b"\x02\x00\x00\x00[]")


# -- versions ------------------------------------------------------------------


def test_method_versions_follow_extension_rules() -> None:
    assert version_for("initialize") == 0
    assert version_for("thread-stream-state-changed") == 11
    assert version_for("thread-owner-discovery", host_id="ssh-1") == 1
    assert version_for("thread-follower-start-turn") == 2
    assert version_for("thread-follower-start-turn", host_id="ssh-1") == 3
    assert version_for("thread-follower-interrupt-turn", params={"expectedTurnId": "t"}) == 4
    assert version_for("thread-follower-interrupt-turn", params={"mode": "user-stop"}) == 3
    assert accepts_version("thread-follower-interrupt-turn", 3)
    assert accepts_version("thread-follower-interrupt-turn", 4)
    assert not accepts_version("thread-follower-interrupt-turn", 3, host_id="ssh-1")
    assert not accepts_version("thread-stream-state-changed", 10)


# -- router + client -----------------------------------------------------------


class _SocketDir:
    """Short temp dir so the socket path stays under the AF_UNIX limit."""

    def __enter__(self) -> Path:
        self.path = Path(tempfile.mkdtemp(prefix="aa-ipc-", dir="/tmp"))
        return self.path

    def __exit__(self, *exc: object) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


def _client(home: Path, **kwargs: Any) -> CodexIpcClient:
    return CodexIpcClient(
        codex_home=home,
        reconnect_delay=0.05,
        request_timeout_ms=2000,
        **kwargs,
    )


async def _settle() -> None:
    for _ in range(3):
        await asyncio.sleep(0)
    await asyncio.sleep(0.02)


def test_client_initializes_against_router() -> None:
    async def run() -> None:
        with _SocketDir() as home:
            router = IpcRouter()
            await router.listen(home / "ipc.sock")
            client = _client(home, socket_path=home / "ipc.sock", allow_router=False)
            seen: list[IpcBroadcast] = []
            client.add_any_broadcast_handler(_collect(seen))
            await client.start()
            await client.wait_until_initialized(timeout=2)
            assert client.client_id
            assert client.connected
            assert not client.is_router
            await _settle()
            assert [b.method for b in seen] == ["client-status-changed"]
            assert seen[0].params["isSelf"] is True
            assert seen[0].params["clientId"] == client.client_id
            await client.stop()
            await router.close()
            assert not client.connected

    asyncio.run(run())


def test_broadcasts_are_fanned_out_and_version_checked() -> None:
    async def run() -> None:
        with _SocketDir() as home:
            router = IpcRouter()
            path = home / "ipc.sock"
            await router.listen(path)
            a = _client(home, socket_path=path, allow_router=False, client_type="a")
            b = _client(home, socket_path=path, allow_router=False, client_type="b")
            c = _client(home, socket_path=path, allow_router=False, client_type="c")
            got_b: list[IpcBroadcast] = []
            got_c: list[IpcBroadcast] = []
            b.add_broadcast_handler("thread-stream-following-changed", _collect(got_b))
            c.add_broadcast_handler("thread-stream-following-changed", _collect(got_c))
            for client in (a, b, c):
                await client.start()
                await client.wait_until_initialized(timeout=2)

            params = {"conversationId": "t1", "hostId": "local", "following": True}
            await a.broadcast("thread-stream-following-changed", params)
            await _settle()
            assert [x.params for x in got_b] == [params]
            assert [x.params for x in got_c] == [params]
            assert got_b[0].source_client_id == a.client_id
            assert got_b[0].version == 1

            await a.broadcast(
                "thread-stream-following-changed",
                params,
                target_client_ids=[c.client_id or ""],
            )
            await _settle()
            assert len(got_b) == 1
            assert len(got_c) == 2

            # A broadcast stamped with a foreign version is dropped by receivers.
            a._write(
                {
                    "type": "broadcast",
                    "method": "thread-stream-following-changed",
                    "sourceClientId": a.client_id,
                    "targetClientIds": None,
                    "params": params,
                    "version": 99,
                }
            )
            await _settle()
            assert len(got_b) == 1
            assert len(got_c) == 2

            for client in (a, b, c):
                await client.stop()
            await router.close()

    asyncio.run(run())


def test_requests_are_routed_through_discovery() -> None:
    async def run() -> None:
        with _SocketDir() as home:
            router = IpcRouter(discovery_timeout=0.5)
            path = home / "ipc.sock"
            await router.listen(path)
            owner = _client(home, socket_path=path, allow_router=False, client_type="owner")
            other = _client(home, socket_path=path, allow_router=False, client_type="other")
            asker = _client(home, socket_path=path, allow_router=False, client_type="asker")
            handled: list[IpcRequest] = []

            async def can_handle(params: Any, request: IpcRequest) -> bool:
                return params.get("conversationId") == "owned"

            async def handle(request: IpcRequest) -> Any:
                handled.append(request)
                return {"supportsUntrustedAppInput": True}

            owner.add_request_handler("thread-owner-discovery", can_handle, handle)
            for client in (owner, other, asker):
                await client.start()
                await client.wait_until_initialized(timeout=2)

            found = await asker.request(
                "thread-owner-discovery", {"hostId": "local", "conversationId": "owned"}
            )
            assert found.ok
            assert found.handled_by_client_id == owner.client_id
            assert found.result == {"supportsUntrustedAppInput": True}
            assert handled[0].source_client_id == asker.client_id
            assert handled[0].version == 1

            missing = await asker.request(
                "thread-owner-discovery",
                {"hostId": "local", "conversationId": "unknown"},
                timeout_ms=3000,
            )
            assert not missing.ok
            assert missing.error == "no-client-found"

            targeted = await asker.request(
                "thread-owner-discovery",
                {"hostId": "local", "conversationId": "owned"},
                target_client_id=owner.client_id,
            )
            assert targeted.ok and targeted.handled_by_client_id == owner.client_id

            wrong_target = await asker.request(
                "thread-owner-discovery",
                {"hostId": "local", "conversationId": "owned"},
                target_client_id=other.client_id,
            )
            assert wrong_target.error == "no-client-found"

            for client in (owner, other, asker):
                await client.stop()
            await router.close()

    asyncio.run(run())


def test_client_becomes_router_when_nobody_listens() -> None:
    async def run() -> None:
        with _SocketDir() as home:
            first = _client(home)
            await first.start()
            await first.wait_until_initialized(timeout=2)
            assert first.is_router
            assert (home / "ipc" / "ipc.sock").exists()
            assert oct((home / "ipc").stat().st_mode & 0o777) == "0o700"
            assert oct((home / "ipc" / "ipc.sock").stat().st_mode & 0o777) == "0o600"

            second = _client(home)
            await second.start()
            await second.wait_until_initialized(timeout=2)
            assert not second.is_router
            assert second.client_id != first.client_id

            await second.stop()
            await first.stop()
            assert not (home / "ipc" / "ipc.sock").exists()

    asyncio.run(run())


def test_client_reconnects_after_router_restart() -> None:
    async def run() -> None:
        with _SocketDir() as home:
            path = home / "ipc.sock"
            router = IpcRouter()
            await router.listen(path)
            client = _client(home, socket_path=path, allow_router=False)
            seen: list[str] = []

            async def record(broadcast: IpcBroadcast) -> None:
                seen.append(broadcast.method)

            client.add_any_broadcast_handler(record)
            await client.start()
            await client.wait_until_initialized(timeout=2)
            first_id = client.client_id

            await router.close()
            await _settle()
            assert not client.initialized
            assert "ipc-connection-reset" in seen

            router = IpcRouter()
            await router.listen(path)
            await client.wait_until_initialized(timeout=2)
            assert client.client_id and client.client_id != first_id
            await _settle()
            assert seen.count("client-status-changed") == 2

            await client.stop()
            await router.close()

    asyncio.run(run())


# -- runtime wiring ------------------------------------------------------------


class _Host(RuntimeHostClient):
    @property
    def connector_id(self) -> str:
        return "conn_test"


class _StubIpc:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def start(self) -> None:
        self.calls.append("start")

    async def stop(self) -> None:
        self.calls.append("stop")


class _StubService(_StubIpc):
    pass


def test_runtime_starts_and_stops_ipc_client() -> None:
    async def run() -> None:
        stub = _StubIpc()
        service = _StubService()
        runtime = CodexRuntime(
            config=RuntimeConfig(runtime="codex", revision=3, values={"codexHome": "/x"}),
            host=_Host(),
            client=None,
            ipc=stub,  # type: ignore[arg-type]
            ipc_service=service,  # type: ignore[arg-type]
            ipc_enabled=True,
        )
        await runtime.start()
        await runtime.stop()
        assert stub.calls == ["start", "stop"]
        assert service.calls == ["start", "stop"]

        disabled = CodexRuntime(
            config=RuntimeConfig(runtime="codex", revision=3, values={"codexHome": "/x"}),
            host=_Host(),
            client=None,
        )
        await disabled.start()
        await disabled.stop()
        assert disabled.ipc is None

    asyncio.run(run())


def test_runtime_builds_ipc_client_from_codex_home() -> None:
    async def run() -> None:
        with _SocketDir() as home:
            runtime = CodexRuntime(
                config=RuntimeConfig(
                    runtime="codex", revision=3, values={"codexHome": str(home)}
                ),
                host=_Host(),
                client=None,
                ipc_enabled=True,
            )
            await runtime.start()
            assert runtime.ipc is not None
            assert runtime.ipc.codex_home == home
            await runtime.ipc.wait_until_initialized(timeout=2)
            assert runtime.ipc.is_router
            await runtime.stop()
            assert not runtime.ipc.connected

    asyncio.run(run())


def _collect(into: list[IpcBroadcast]):
    async def handler(broadcast: IpcBroadcast) -> None:
        into.append(broadcast)

    return handler


def test_socket_dir_cleanup_helper_uses_tmp() -> None:
    with _SocketDir() as home:
        assert str(home).startswith("/tmp/aa-ipc-")
        assert os.path.isdir(home)
