from __future__ import annotations

import asyncio
import json
import shutil
import sys
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import (
    RuntimeSessionStateCache,
    SessionNotice,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.ipc import (
    CodexIpcClient,
    CodexIpcService,
    CodexIpcSessionProjector,
    FollowedThread,
    FollowerEvent,
    IpcBroadcast,
    IpcRequest,
    IpcRouter,
    JsonPatchError,
    ThreadFollower,
    apply_patches,
    candidate_thread_ids,
)

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="Codex IPC uses Unix sockets"
)

THREAD_A = "01a12048-c50d-7cb3-9de3-f0a61be677b8"
THREAD_B = "01a124e5-815c-7e42-aea7-25d46a8450c3"
THREAD_C = "01a123db-a38a-7a40-9c40-36b5a5794ffb"


# -- json patch ----------------------------------------------------------------


def test_apply_patches_add_replace_remove_without_mutation() -> None:
    doc = {"turnHistory": {"history": {"entitiesByKey": {}, "islands": [{"entries": []}]}}, "n": 1}
    patches = [
        {"op": "add", "path": ["turnHistory", "history", "entitiesByKey", "turn:1"], "value": {"items": []}},
        {"op": "add", "path": ["turnHistory", "history", "islands", 0, "entries", 0], "value": {"key": "turn:1"}},
        {"op": "add", "path": ["turnHistory", "history", "entitiesByKey", "turn:1", "items", 0], "value": {"type": "agentMessage", "text": ""}},
        {"op": "replace", "path": ["turnHistory", "history", "entitiesByKey", "turn:1", "items", 0, "text"], "value": "hi"},
        {"op": "replace", "path": ["n"], "value": 2},
        {"op": "remove", "path": ["turnHistory", "history", "islands", 0, "entries", 0]},
    ]
    result = apply_patches(doc, patches)
    assert result["n"] == 2
    assert result["turnHistory"]["history"]["entitiesByKey"]["turn:1"]["items"] == [
        {"type": "agentMessage", "text": "hi"}
    ]
    assert result["turnHistory"]["history"]["islands"][0]["entries"] == []
    assert doc["n"] == 1 and doc["turnHistory"]["history"]["entitiesByKey"] == {}


def test_apply_patches_rejects_bad_paths() -> None:
    with pytest.raises(JsonPatchError):
        apply_patches({"a": []}, [{"op": "replace", "path": ["a", 3], "value": 1}])
    with pytest.raises(JsonPatchError):
        apply_patches({"a": {}}, [{"op": "remove", "path": ["a", "missing"]}])
    with pytest.raises(JsonPatchError):
        apply_patches({}, [{"op": "bogus", "path": ["a"]}])
    assert apply_patches({"a": [1]}, [{"op": "add", "path": "/a/-", "value": 2}]) == {"a": [1, 2]}


# -- candidates ----------------------------------------------------------------


def test_candidate_thread_ids_prefers_locks_then_recent_sessions() -> None:
    with _TempHome() as home:
        locks = home / "thread-writer-locks"
        locks.mkdir()
        (locks / f"{THREAD_A}.lock").touch()
        (locks / ".coordination.lock").touch()
        (home / "session_index.jsonl").write_text(
            "\n".join(
                [
                    json.dumps({"id": THREAD_B, "updated_at": "2026-10-10T08:00:00Z"}),
                    json.dumps({"id": THREAD_C, "updated_at": "2026-10-10T09:00:00Z"}),
                    json.dumps({"id": THREAD_A, "updated_at": "2026-10-10T07:00:00Z"}),
                    "not json",
                    json.dumps({"id": THREAD_B, "updated_at": "2026-10-10T10:00:00Z"}),
                ]
            ),
            encoding="utf-8",
        )
        assert candidate_thread_ids(home, recent_limit=2) == [THREAD_A, THREAD_B, THREAD_C]
        assert candidate_thread_ids(home / "missing") == []


# -- fakes ---------------------------------------------------------------------


class _TempHome:
    def __enter__(self) -> Path:
        self.path = Path(tempfile.mkdtemp(prefix="aa-ipcf-", dir="/tmp"))
        return self.path

    def __exit__(self, *exc: object) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


def _client(home: Path, path: Path, client_type: str = "agents-anywhere") -> CodexIpcClient:
    return CodexIpcClient(
        codex_home=home,
        socket_path=path,
        allow_router=False,
        reconnect_delay=0.05,
        request_timeout_ms=2000,
        client_type=client_type,
    )


class FakeOwner:
    """A window that owns ``thread_id`` and speaks the owner side of the protocol."""

    def __init__(self, client: CodexIpcClient, thread_id: str, state: dict[str, Any]) -> None:
        self.client = client
        self.thread_id = thread_id
        self.state = state
        self.revision = 1
        self.followers: list[str] = []
        self.snapshots_sent = 0
        client.add_request_handler("thread-owner-discovery", self._can_handle, self._handle)
        client.add_broadcast_handler("thread-stream-following-changed", self._on_following)

    async def _can_handle(self, params: Any, request: IpcRequest) -> bool:
        return params.get("hostId") == "local" and params.get("conversationId") == self.thread_id

    async def _handle(self, request: IpcRequest) -> Any:
        return {"supportsUntrustedAppInput": True}

    async def _on_following(self, broadcast: IpcBroadcast) -> None:
        params = broadcast.params
        if params.get("conversationId") != self.thread_id or params.get("hostId") != "local":
            return
        source = broadcast.source_client_id or ""
        if params.get("following"):
            if source not in self.followers:
                self.followers.append(source)
            await self.send_snapshot([source])
        elif source in self.followers:
            self.followers.remove(source)

    async def send_snapshot(self, targets: list[str] | None = None) -> None:
        self.snapshots_sent += 1
        await self.client.broadcast(
            "thread-stream-state-changed",
            {
                "conversationId": self.thread_id,
                "hostId": "local",
                "change": {
                    "type": "snapshot",
                    "revision": self.revision,
                    "conversationState": self.state,
                },
            },
            target_client_ids=targets or list(self.followers),
        )

    async def send_patches(self, patches: list[dict[str, Any]], *, base: int | None = None) -> None:
        base_revision = self.revision if base is None else base
        self.revision += 1
        self.state = apply_patches(self.state, patches)
        await self.client.broadcast(
            "thread-stream-state-changed",
            {
                "conversationId": self.thread_id,
                "hostId": "local",
                "change": {
                    "type": "patches",
                    "baseRevision": base_revision,
                    "revision": self.revision,
                    "patches": patches,
                    "acceptedTextChanges": [],
                },
            },
            target_client_ids=list(self.followers),
        )


def _state(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": THREAD_A,
        "title": "检查 meshcall 项目",
        "cwd": "/Users/t4wefan/code/github/meshcall",
        "threadRuntimeStatus": {"type": "idle"},
        "requests": [],
        "originator": "Codex Desktop",
        "source": "vscode",
        "updatedAt": 1791621499000,
        "recencyAt": 1791620383000,
        "turnHistory": {"history": {"entitiesByKey": {}, "islands": []}},
    }
    base.update(overrides)
    return base


async def _settle(rounds: int = 6) -> None:
    for _ in range(rounds):
        await asyncio.sleep(0.01)


async def _wait_for(predicate, timeout: float = 3.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


# -- follower ------------------------------------------------------------------


def test_follower_discovers_owner_and_applies_snapshot_and_patches() -> None:
    async def run() -> None:
        with _TempHome() as home:
            path = home / "ipc.sock"
            router = IpcRouter(discovery_timeout=0.5)
            await router.listen(path)
            owner_client = _client(home, path, "desktop")
            owner = FakeOwner(owner_client, THREAD_A, _state())
            follower_client = _client(home, path)
            for client in (owner_client, follower_client):
                await client.start()
                await client.wait_until_initialized(timeout=2)

            follower = ThreadFollower(client=follower_client, discovery_timeout_ms=1500)
            follower.attach()
            events: list[FollowerEvent] = []

            async def listen(event: FollowerEvent) -> None:
                events.append(event)

            follower.add_listener(listen)

            thread = await follower.follow(THREAD_A)
            assert thread.status == "following"
            assert thread.owner_client_id == owner_client.client_id
            await _wait_for(lambda: follower.get(THREAD_A).has_state)
            thread = follower.get(THREAD_A)
            assert thread.revision == 1 and thread.state["title"] == "检查 meshcall 项目"
            assert [e.kind for e in events] == ["status", "snapshot"]

            await owner.send_patches(
                [{"op": "replace", "path": ["threadRuntimeStatus"], "value": {"type": "active", "activeFlags": []}}]
            )
            await _wait_for(lambda: follower.get(THREAD_A).revision == 2)
            assert follower.get(THREAD_A).state["threadRuntimeStatus"]["type"] == "active"
            assert events[-1].kind == "patches" and len(events[-1].patches) == 1

            # A patch with a stale base revision triggers a resync (new snapshot).
            before = owner.snapshots_sent
            await owner.send_patches([{"op": "replace", "path": ["n"], "value": 1}], base=0)
            await _wait_for(lambda: owner.snapshots_sent > before)
            await _wait_for(lambda: follower.get(THREAD_A).revision == owner.revision)
            assert follower.get(THREAD_A).state.get("n") == 1

            # Unknown threads have no owner; the router answers quickly.
            missing = await follower.follow(THREAD_B)
            assert missing.status == "no_owner"

            # Owner disconnect is reported through client-status-changed.
            await owner_client.stop()
            await _wait_for(lambda: follower.get(THREAD_A).status == "owner_lost")
            assert follower.get(THREAD_A).owner_client_id is None

            await follower_client.stop()
            await router.close()

    asyncio.run(run())


def test_follower_reannounces_on_status_request_and_reconnect() -> None:
    async def run() -> None:
        with _TempHome() as home:
            path = home / "ipc.sock"
            router = IpcRouter(discovery_timeout=0.5)
            await router.listen(path)
            owner_client = _client(home, path, "vscode")
            owner = FakeOwner(owner_client, THREAD_A, _state())
            follower_client = _client(home, path)
            for client in (owner_client, follower_client):
                await client.start()
                await client.wait_until_initialized(timeout=2)
            follower = ThreadFollower(client=follower_client, discovery_timeout_ms=1500)
            follower.attach()
            await follower.follow(THREAD_A)
            await _wait_for(lambda: follower.get(THREAD_A).has_state)
            assert owner.snapshots_sent == 1

            await owner_client.broadcast(
                "thread-stream-following-status-requested",
                {"conversationId": THREAD_A, "hostId": "local"},
            )
            await _wait_for(lambda: owner.snapshots_sent == 2)

            # Router restart: connection reset, then re-follow once initialized.
            await router.close()
            await _wait_for(lambda: follower.get(THREAD_A).status == "offline")
            router = IpcRouter(discovery_timeout=0.5)
            await router.listen(path)
            await owner_client.wait_until_initialized(timeout=2)
            await follower_client.wait_until_initialized(timeout=2)
            await _wait_for(lambda: follower.get(THREAD_A).status == "following" and follower.get(THREAD_A).has_state)
            assert follower.get(THREAD_A).owner_client_id == owner_client.client_id

            await follower.unfollow(THREAD_A)
            await _settle()
            assert follower_client.client_id not in owner.followers

            await follower_client.stop()
            await owner_client.stop()
            await router.close()

    asyncio.run(run())


# -- projection ----------------------------------------------------------------


class _Host(RuntimeHostClient):
    def __init__(self) -> None:
        self.meta: list[dict[str, Any]] = []
        self.states: list[dict[str, Any]] = []
        self.notices: list[SessionNotice] = []

    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def session_meta_upsert(self, session_id, runtime, external_session_id=None, title=None, cwd=None, ordering_time=None, metadata=None):
        self.meta.append({"session_id": session_id, "external_session_id": external_session_id, "title": title, "cwd": cwd, "ordering_time": ordering_time, "metadata": dict(metadata or {})})

    async def session_state_update(self, session_id, runtime, status=None, selections=None, external_session_id=None, status_reason=None, error=None, metadata=None):
        self.states.append({"session_id": session_id, "status": status, "metadata": dict(metadata or {})})

    async def notice_upsert(self, notice):
        self.notices.append(notice)


def _event(kind: str, state: Mapping[str, Any] | None, *, status: str = "following", patches=(), revision: int = 1) -> FollowerEvent:
    thread = FollowedThread(
        thread_id=THREAD_A,
        status=status,  # type: ignore[arg-type]
        owner_client_id="owner-1" if status == "following" else None,
        revision=revision if state is not None else None,
        state=state,
    )
    return FollowerEvent(kind=kind, thread=thread, patches=tuple(patches))  # type: ignore[arg-type]


def test_projector_mirrors_meta_state_and_approval_notices() -> None:
    async def run() -> None:
        host = _Host()
        states = RuntimeSessionStateCache("codex", host)
        notices = CodexNoticeRegistry()
        projector = CodexIpcSessionProjector(host=host, session_states=states, notices=notices)

        pending = {
            "method": "item/commandExecution/requestApproval",
            "requestId": 7,
            "params": {"itemId": "item-1", "command": "rm -rf build", "turnId": "turn-1", "cwd": "/w"},
        }
        await projector.handle(
            _event("snapshot", _state(threadRuntimeStatus={"type": "active", "activeFlags": ["waitingOnApproval"]}, requests=[pending]))
        )
        assert len(host.meta) == 1
        meta = host.meta[0]
        assert meta["external_session_id"] == THREAD_A
        assert meta["title"] == "检查 meshcall 项目"
        assert meta["cwd"] == "/Users/t4wefan/code/github/meshcall"
        assert meta["ordering_time"] == "2026-10-10T08:19:43.000000Z"
        assert meta["metadata"]["attachment"] == "ipc"
        assert host.states[-1]["status"] == "waiting_approval"
        assert host.states[-1]["metadata"]["ipc"]["ownerClientId"] == "owner-1"
        assert len(host.notices) == 1
        notice = host.notices[0]
        assert notice.interaction_type == "approval"
        assert notice.message == "rm -rf build"
        assert notice.context["approvalSource"]["requestId"] == 7
        assert notice.metadata["transport"] == "ipc"
        assert notices.open_blocking_for_session(meta["session_id"])

        # Patches that only touch history do not re-project.
        state_updates = len(host.states)
        await projector.handle(
            _event("patches", _state(requests=[pending]), patches=[{"op": "add", "path": ["turnHistory", "x"], "value": 1}], revision=2)
        )
        assert len(host.states) == state_updates

        # Request resolved and turn running.
        await projector.handle(
            _event("patches", _state(threadRuntimeStatus={"type": "active", "activeFlags": []}, requests=[]), patches=[{"op": "replace", "path": ["requests"], "value": []}], revision=3)
        )
        assert host.states[-1]["status"] == "running"
        assert host.notices[-1].status == "resolved"
        assert not notices.open_blocking_for_session(meta["session_id"])

        # Idle again; meta unchanged so no second meta upsert.
        await projector.handle(_event("patches", _state(), patches=[{"op": "replace", "path": ["threadRuntimeStatus"], "value": {"type": "idle"}}], revision=4))
        assert host.states[-1]["status"] == "idle"
        assert len(host.meta) == 1

        # Owner lost downgrades to detached idle.
        await projector.handle(_event("status", None, status="owner_lost"))
        assert host.states[-1]["metadata"]["attachment"] == "none"
        assert host.states[-1]["metadata"]["ipc"]["followStatus"] == "owner_lost"

    asyncio.run(run())


def test_projector_ignores_threads_never_seen_when_detached() -> None:
    async def run() -> None:
        host = _Host()
        projector = CodexIpcSessionProjector(
            host=host,
            session_states=RuntimeSessionStateCache("codex", host),
            notices=CodexNoticeRegistry(),
        )
        await projector.handle(_event("status", None, status="no_owner"))
        assert host.states == [] and host.meta == []

    asyncio.run(run())


# -- service -------------------------------------------------------------------


def test_service_scans_candidates_and_follows_announced_threads() -> None:
    async def run() -> None:
        with _TempHome() as home:
            (home / "session_index.jsonl").write_text(
                json.dumps({"id": THREAD_A, "updated_at": "2026-10-10T08:00:00Z"})
                + "\n"
                + json.dumps({"id": THREAD_B, "updated_at": "2026-10-10T09:00:00Z"})
                + "\n",
                encoding="utf-8",
            )
            path = home / "ipc.sock"
            router = IpcRouter(discovery_timeout=0.5)
            await router.listen(path)
            owner_client = _client(home, path, "desktop")
            FakeOwner(owner_client, THREAD_A, _state())
            await owner_client.start()
            await owner_client.wait_until_initialized(timeout=2)

            events: list[FollowerEvent] = []

            async def on_event(event: FollowerEvent) -> None:
                events.append(event)

            client = _client(home, path)
            await client.start()
            service = CodexIpcService(
                client=client,
                codex_home=home,
                on_event=on_event,
                scan_interval=60,
                retry_interval=60,
            )
            await service.start()
            await _wait_for(lambda: service.scan_count >= 1)
            await _wait_for(lambda: service.follower.get(THREAD_A) is not None and service.follower.get(THREAD_A).has_state)
            assert service.follower.get(THREAD_B).status == "no_owner"
            assert any(e.kind == "snapshot" for e in events)

            # Another window announcing a new thread makes the service follow it.
            second_client = _client(home, path, "vscode")
            FakeOwner(second_client, THREAD_C, _state(id=THREAD_C, title="second"))
            await second_client.start()
            await second_client.wait_until_initialized(timeout=2)
            await second_client.broadcast(
                "thread-stream-following-changed",
                {"conversationId": THREAD_C, "hostId": "local", "following": True},
            )
            await _wait_for(lambda: service.follower.get(THREAD_C) is not None and service.follower.get(THREAD_C).has_state)
            assert service.follower.get(THREAD_C).state["title"] == "second"

            await service.stop()
            await client.stop()
            await second_client.stop()
            await owner_client.stop()
            await router.close()

    asyncio.run(run())
