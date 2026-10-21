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
    CAPABILITY_SESSION_INTERRUPT,
    CAPABILITY_SESSION_SEND_MESSAGE,
    RuntimeConfig,
    RuntimeSessionStateCache,
    RuntimeTimelineItem,
    RuntimeUnsupportedError,
    SessionNotice,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.ipc import (
    CodexIpcClient,
    CodexIpcSessionProjector,
    CodexIpcTurnController,
    FollowedThread,
    FollowerEvent,
    IpcBroadcast,
    IpcRequest,
    IpcRouter,
    ThreadFollower,
    active_turn_id,
    thread_snapshot_from_conversation_state,
)
from connector.runtimes.codex.ipc.control import turn_start_request
from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator

pytestmark = pytest.mark.skipif(
    sys.platform == "win32", reason="Codex IPC uses Unix sockets"
)

THREAD = "01a124e5-815c-7e42-aea7-25d46a8450c3"
TURN_1 = "01a124e5-82a7-7d41-a1a8-998ccf2e7597"


def _turn(turn_id: str, status: str, items: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "params": {"threadId": THREAD, "input": [{"type": "text", "text": "hi"}]},
        "turnId": turn_id,
        "status": status,
        "items": items,
        "completedItemIds": {},
    }


def _state(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": THREAD,
        "title": "回应问候",
        "cwd": "/Users/t4wefan/Documents/Codex/2026-10-10/new-chat",
        "threadRuntimeStatus": {"type": "idle"},
        "requests": [],
        "originator": "Codex Desktop",
        "source": "vscode",
        "updatedAt": 1791621499000,
        "currentPermissions": {
            "approvalPolicy": "never",
            "approvalsReviewer": "user",
            "sandboxPolicy": {"type": "dangerFullAccess"},
        },
        "latestCollaborationMode": {
            "mode": "default",
            "settings": {"reasoning_effort": "high", "model": "gpt-6.1-sol"},
        },
        "turnHistory": {
            "history": {
                "entitiesByKey": {
                    f"turn:{TURN_1}": _turn(
                        TURN_1,
                        "completed",
                        [
                            {
                                "type": "userMessage",
                                "id": "um-1",
                                "content": [{"type": "text", "text": "你好\n"}],
                            },
                            {
                                "type": "agentMessage",
                                "id": "msg_1",
                                "text": "你好！有什么想一起做的？",
                                "phase": "final_answer",
                            },
                        ],
                    )
                },
                "islands": [{"id": "tail:0", "entries": [{"key": f"turn:{TURN_1}"}]}],
            }
        },
    }
    base.update(overrides)
    return base


# -- timeline conversion -------------------------------------------------------


def test_thread_snapshot_from_conversation_state_orders_turns_and_items() -> None:
    state = _state()
    history = state["turnHistory"]["history"]
    history["entitiesByKey"]["tail:0:local:abc"] = _turn(
        "", "inProgress", [{"type": "agentMessage", "id": "msg_2", "text": "..."}]
    )
    history["entitiesByKey"]["tail:0:local:abc"].pop("turnId")
    history["islands"][0]["entries"].append({"key": "tail:0:local:abc"})
    snapshot = thread_snapshot_from_conversation_state(state)
    assert snapshot["id"] == THREAD
    assert [turn["id"] for turn in snapshot["turns"]] == [TURN_1, "tail:0:local:abc"]
    assert snapshot["turns"][0]["items"][1]["turnId"] == TURN_1
    assert snapshot["turns"][1]["status"] == "inProgress"
    assert active_turn_id(state) == "tail:0:local:abc"
    assert active_turn_id(_state()) is None

    accumulator = CodexTimelineAccumulator()
    items = accumulator.items_from_thread_snapshot(
        session_id="sess_1", external_session_id=THREAD, thread=snapshot, limit=None
    )
    assert [item.role for item in items[:2]] == ["user", "assistant"]
    assert "你好！" in json.dumps(items[1].content, ensure_ascii=False)


def test_turn_start_request_mirrors_owner_settings() -> None:
    request = turn_start_request(THREAD, _state(), "hello", "cm-1")
    assert request["threadId"] == THREAD
    assert request["input"] == [{"type": "text", "text": "hello", "text_elements": []}]
    assert request["approvalPolicy"] == "never"
    assert request["sandboxPolicy"] == {"type": "dangerFullAccess"}
    assert request["collaborationMode"]["settings"]["model"] == "gpt-6.1-sol"
    assert request["clientUserMessageId"] == "cm-1"


# -- fakes ---------------------------------------------------------------------


class _TempHome:
    def __enter__(self) -> Path:
        self.path = Path(tempfile.mkdtemp(prefix="aa-ipcc-", dir="/tmp"))
        return self.path

    def __exit__(self, *exc: object) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


class _Host(RuntimeHostClient):
    def __init__(self) -> None:
        self.states: list[dict[str, Any]] = []
        self.notices: list[SessionNotice] = []
        self.meta: list[dict[str, Any]] = []
        self.syncs: list[dict[str, Any]] = []
        self.item_upserts: list[RuntimeTimelineItem] = []
        self.turn_ends: list[dict[str, Any]] = []

    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def session_meta_upsert(self, session_id, runtime, external_session_id=None, title=None, cwd=None, ordering_time=None, metadata=None):
        self.meta.append({"session_id": session_id, "title": title})

    async def session_state_update(self, session_id, runtime, status=None, selections=None, external_session_id=None, status_reason=None, error=None, metadata=None):
        self.states.append({"session_id": session_id, "status": status, "metadata": dict(metadata or {}), "error": error})

    async def notice_upsert(self, notice):
        self.notices.append(notice)

    async def timeline_sync(self, session_id, runtime, items, external_session_id=None, complete=False, metadata=None):
        self.syncs.append({"session_id": session_id, "items": items, "complete": complete, "metadata": dict(metadata or {})})

    async def timeline_item_upsert(self, item):
        self.item_upserts.append(item)

    async def session_turn_ended(self, session_id, runtime, external_session_id=None, turn_id=None, outcome="completed", metadata=None):
        self.turn_ends.append({"session_id": session_id, "turn_id": turn_id, "outcome": outcome})

    async def session_capabilities_update(self, capabilities):
        self.capability_updates = getattr(self, "capability_updates", [])
        self.capability_updates.append(capabilities)


class FakeOwner:
    def __init__(self, client: CodexIpcClient, thread_id: str, state: dict[str, Any]) -> None:
        self.client = client
        self.thread_id = thread_id
        self.state = state
        self.revision = 1
        self.followers: list[str] = []
        self.requests: list[tuple[str, Any]] = []
        self.fail_next: str | None = None
        client.add_request_handler("thread-owner-discovery", self._owns, self._discovered)
        for method in (
            "thread-follower-start-turn",
            "thread-follower-steer-turn",
            "thread-follower-interrupt-turn",
            "thread-follower-command-approval-decision",
            "thread-follower-file-approval-decision",
            "thread-follower-permissions-request-approval-response",
            "thread-follower-submit-user-input",
        ):
            client.add_request_handler(method, self._owns, self._handle)
        client.add_broadcast_handler("thread-stream-following-changed", self._on_following)

    async def _owns(self, params: Any, request: IpcRequest) -> bool:
        return isinstance(params, Mapping) and params.get("conversationId") == self.thread_id

    async def _discovered(self, request: IpcRequest) -> Any:
        return {"supportsUntrustedAppInput": True}

    async def _handle(self, request: IpcRequest) -> Any:
        self.requests.append((request.method, request.params))
        if self.fail_next:
            error, self.fail_next = self.fail_next, None
            raise RuntimeError(error)
        if request.method == "thread-follower-start-turn":
            return {"method": request.method, "result": {"turn": {"id": "turn-new", "status": "inProgress", "items": []}}}
        if request.method == "thread-follower-steer-turn":
            return {"method": request.method, "result": {"turn": {"id": "turn-new"}}}
        if request.method == "thread-follower-interrupt-turn":
            return {"method": request.method, "result": {"interruptedTurnId": request.params["expectedTurnId"], "ok": True}}
        return {"method": request.method, "result": {"ok": True}}

    async def _on_following(self, broadcast: IpcBroadcast) -> None:
        params = broadcast.params
        if params.get("conversationId") != self.thread_id:
            return
        source = broadcast.source_client_id or ""
        if params.get("following"):
            if source not in self.followers:
                self.followers.append(source)
            await self.client.broadcast(
                "thread-stream-state-changed",
                {"conversationId": self.thread_id, "hostId": "local", "change": {"type": "snapshot", "revision": self.revision, "conversationState": self.state}},
                target_client_ids=[source],
            )


def _client(home: Path, path: Path, client_type: str = "agents-anywhere") -> CodexIpcClient:
    return CodexIpcClient(codex_home=home, socket_path=path, allow_router=False, reconnect_delay=0.05, request_timeout_ms=2000, client_type=client_type)


async def _wait_for(predicate, timeout: float = 3.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


# -- controller ----------------------------------------------------------------


def test_controller_drives_owner_for_turns_and_approvals() -> None:
    async def run() -> None:
        with _TempHome() as home:
            path = home / "ipc.sock"
            router = IpcRouter(discovery_timeout=0.5)
            await router.listen(path)
            owner_client = _client(home, path, "vscode")
            owner = FakeOwner(owner_client, THREAD, _state())
            client = _client(home, path)
            for c in (owner_client, client):
                await c.start()
                await c.wait_until_initialized(timeout=2)
            follower = ThreadFollower(client=client, discovery_timeout_ms=1500)
            follower.attach()
            await follower.follow(THREAD)
            await _wait_for(lambda: follower.get(THREAD).has_state)

            host = _Host()
            states = RuntimeSessionStateCache("codex", host)
            notices = CodexNoticeRegistry()
            active: dict[str, str] = {}
            controller = CodexIpcTurnController(
                client=client,
                follower=follower,
                host=host,
                session_states=states,
                active_turn_ids=active,
                notices=notices,
                pending_messages=PendingClientMessageRegistry(connector_id="conn_test"),
            )
            thread = controller.attached_thread(THREAD)
            assert thread is not None
            assert controller.attached_thread("unknown") is None

            result = await controller.start_turn("sess_1", thread, "通过 IPC 发送", client_message_id="cm-1")
            assert result.ok and result.result["turnId"] == "turn-new"
            assert active["sess_1"] == "turn-new"
            assert [s["status"] for s in host.states] == ["waiting", "running"]
            method, params = owner.requests[-1]
            assert method == "thread-follower-start-turn"
            assert params["turnStart"]["request"]["input"][0]["text"] == "通过 IPC 发送"
            assert params["turnStart"]["request"]["clientUserMessageId"] == "cm-1"

            steered = await controller.steer_turn("sess_1", thread, "再补一句", client_message_id="cm-2")
            assert steered.ok and steered.result["turnId"] == "turn-new"
            assert owner.requests[-1][0] == "thread-follower-steer-turn"
            assert owner.requests[-1][1]["input"][0]["text"] == "再补一句"

            interrupted = await controller.interrupt_session("sess_1", thread)
            assert interrupted.ok and interrupted.result["turnId"] == "turn-new"
            assert owner.requests[-1][1] == {"conversationId": THREAD, "mode": "user-stop", "expectedTurnId": "turn-new"}
            assert host.states[-1]["status"] == "stopping"

            # Approval reply routed by the notice's approvalSource.
            notice = SessionNotice(
                notice_id="notice_approval_x",
                session_id="sess_1",
                runtime="codex",
                type="interaction",
                title="approve",
                interaction_type="approval",
                blocking={"scope": "session", "targetId": "sess_1"},
                response_required=True,
                context={"approvalSource": {"requestId": 7, "method": "item/commandExecution/requestApproval", "threadId": THREAD}},
                metadata={"transport": "ipc"},
            )
            notices.upsert(notice)
            assert controller.ipc_notice_thread("notice_approval_x") is not None
            replied = await controller.respond_interaction("sess_1", thread, "notice_approval_x", "approve")
            assert replied.ok and replied.result["decision"] == "accept"
            assert owner.requests[-1] == ("thread-follower-command-approval-decision", {"conversationId": THREAD, "requestId": 7, "decision": "accept"})
            assert notices.get("notice_approval_x").status == "resolved"
            assert [n.status for n in host.notices[-2:]] == ["responding", "resolved"]

            # Owner-side failure keeps the notice open and reports an error code.
            notices.upsert(notice)
            owner.fail_next = "owner exploded"
            failed = await controller.respond_interaction("sess_1", thread, "notice_approval_x", "reject")
            assert not failed.ok and failed.code.startswith("codex_ipc_")
            assert notices.get("notice_approval_x").status == "open"

            # Start-turn failure marks the session as error.
            owner.fail_next = "no-client-found"
            bad = await controller.start_turn("sess_1", thread, "x")
            assert not bad.ok and bad.code == "codex_ipc_no_client_found"
            assert host.states[-1]["status"] == "error"

            await client.stop()
            await owner_client.stop()
            await router.close()

    asyncio.run(run())


# -- projector: turns and timeline --------------------------------------------


def _event(kind: str, state: Mapping[str, Any], patches=(), revision: int = 1) -> FollowerEvent:
    thread = FollowedThread(thread_id=THREAD, status="following", owner_client_id="owner-1", revision=revision, state=state)
    return FollowerEvent(kind=kind, thread=thread, patches=tuple(patches))  # type: ignore[arg-type]


def test_projector_publishes_timeline_and_tracks_turns() -> None:
    async def run() -> None:
        host = _Host()
        states = RuntimeSessionStateCache("codex", host)
        active: dict[str, str] = {}
        projector = CodexIpcSessionProjector(
            host=host,
            session_states=states,
            notices=CodexNoticeRegistry(),
            active_turn_ids=active,
            timeline=CodexTimelineAccumulator(),
        )
        await projector.handle(_event("snapshot", _state()))
        assert len(host.syncs) == 1 and host.syncs[0]["complete"]
        assert len(host.syncs[0]["items"]) == 2
        assert active == {}

        # A new in-progress turn with a streaming agent message.
        running = _state(threadRuntimeStatus={"type": "active", "activeFlags": []})
        history = running["turnHistory"]["history"]
        history["entitiesByKey"]["tail:0:local:n"] = _turn("turn-2", "inProgress", [{"type": "agentMessage", "id": "msg_2", "text": "今晚"}])
        history["islands"][0]["entries"].append({"key": "tail:0:local:n"})
        await projector.handle(_event("patches", running, patches=[{"op": "replace", "path": ["threadRuntimeStatus"], "value": {"type": "active"}}, {"op": "add", "path": ["turnHistory", "history", "entitiesByKey", "tail:0:local:n"], "value": {}}], revision=2))
        session_id = host.states[-1]["session_id"]
        assert host.states[-1]["status"] == "running"
        assert active[session_id] == "turn-2"
        assert len(host.syncs) == 1
        assert [i.turn_id for i in host.item_upserts] == ["turn-2"]

        # Text grows: only the changed item is upserted again.
        history["entitiesByKey"]["tail:0:local:n"]["items"][0]["text"] = "今晚吃面"
        await projector.handle(_event("patches", running, patches=[{"op": "replace", "path": ["turnHistory", "history", "entitiesByKey", "tail:0:local:n", "items", 0, "text"], "value": "今晚吃面"}], revision=3))
        assert len(host.item_upserts) == 2
        assert "今晚吃面" in json.dumps(host.item_upserts[-1].content, ensure_ascii=False)

        # Turn completes: idle, active turn cleared, turn-ended published.
        done = _state(threadRuntimeStatus={"type": "idle"})
        done["turnHistory"]["history"]["entitiesByKey"]["tail:0:local:n"] = _turn("turn-2", "completed", [{"type": "agentMessage", "id": "msg_2", "text": "今晚吃面"}])
        done["turnHistory"]["history"]["islands"][0]["entries"].append({"key": "tail:0:local:n"})
        await projector.handle(_event("patches", done, patches=[{"op": "replace", "path": ["threadRuntimeStatus"], "value": {"type": "idle"}}], revision=4))
        assert host.states[-1]["status"] == "idle"
        assert session_id not in active
        assert host.turn_ends == [{"session_id": session_id, "turn_id": "turn-2", "outcome": "completed"}]

    asyncio.run(run())


# -- runtime routing -----------------------------------------------------------


class _RecordingClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any, str | None]] = []
        self.client_id = "self-1"

    async def request(self, method, params, *, target_client_id=None, host_id=None, timeout_ms=None):
        from connector.runtimes.codex.ipc import IpcResponse

        self.calls.append((method, params, target_client_id))
        if method == "thread-follower-start-turn":
            return IpcResponse(request_id="r", result_type="success", method=method, handled_by_client_id=target_client_id, result={"result": {"turn": {"id": "turn-ipc"}}})
        return IpcResponse(request_id="r", result_type="success", method=method, handled_by_client_id=target_client_id, result={"ok": True})

    async def start(self) -> None: ...

    async def stop(self) -> None: ...


class _StubService:
    def __init__(self, follower: Any) -> None:
        self.follower = follower

    async def start(self) -> None: ...

    async def stop(self) -> None: ...


class _StubFollower:
    def __init__(self, thread: FollowedThread) -> None:
        self.thread = thread

    def get(self, thread_id: str) -> FollowedThread | None:
        return self.thread if thread_id == self.thread.thread_id else None


def test_runtime_routes_attached_sessions_through_ipc() -> None:
    async def run() -> None:
        host = _Host()
        thread = FollowedThread(thread_id=THREAD, status="following", owner_client_id="owner-1", revision=3, state=_state())
        client = _RecordingClient()
        runtime = CodexRuntime(
            config=RuntimeConfig(runtime="codex", revision=3, values={"codexHome": "/x"}),
            host=host,
            client=None,
            ipc=client,  # type: ignore[arg-type]
            ipc_service=_StubService(_StubFollower(thread)),  # type: ignore[arg-type]
        )
        session_id = "sess_ipc"
        result = await runtime.start_turn(session_id, THREAD, "hello", client_message_id="cm-9")
        assert result.ok and result.result["turnId"] == "turn-ipc" and result.result["transport"] == "ipc"
        assert client.calls[0][0] == "thread-follower-start-turn" and client.calls[0][2] == "owner-1"

        snapshot = await runtime.get_session_snapshot(session_id, THREAD)
        assert snapshot.complete and snapshot.metadata["source"] == "codex.ipc.snapshot"
        assert len(snapshot.items) == 2

        # Capabilities: attached session can interrupt while running, send when idle.
        running = await runtime.get_session_capabilities(session_id, THREAD)
        by_id = {c.capability_id: c.available for c in running.capabilities}
        assert by_id[CAPABILITY_SESSION_INTERRUPT] is True
        assert by_id[CAPABILITY_SESSION_SEND_MESSAGE] is False

        interrupted = await runtime.interrupt_session(session_id)
        assert interrupted.ok and client.calls[-1][0] == "thread-follower-interrupt-turn"

        # Sessions that are not followed keep the SDK path (unsupported without a client).
        with pytest.raises(RuntimeUnsupportedError):
            await runtime.start_turn("sess_other", "01a12048-c50d-7cb3-9de3-f0a61be677b8", "x")

    asyncio.run(run())
